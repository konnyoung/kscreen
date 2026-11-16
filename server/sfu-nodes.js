// Media servers (LiveKit SFU nodes) and the room mode (P2P mesh or SFU).
//
// - Nodes are managed in the admin panel (address + secret; the API key defaults to "kscreen", what
//   sfu-server/install-livekit.sh generates) and saved in KSCREEN_DATA_DIR/sfu.json (default
//   ~/.kscreen, outside the project so a deploy never overwrites it). On the first start the
//   LIVEKIT_* variables of .env.local become the first node.
// - Each SFU room lives on one node (room.sfuNode). Clients learn `${node}@${rev}` in the poll and
//   reconnect when it changes: migrating a room, or editing the node's address/secret, applies
//   right away. Nothing depends on server memory: the rev is saved with the node.
// - Health: every node is asked for its rooms (Twirp ListRooms) every 15 s, which proves it is up
//   AND that the secret is right. A node down for two checks in a row has its rooms moved to a
//   healthy one (automatic failover, can be turned off).
// - Traffic: clients in SFU rooms report what they send and receive (kbps) with the poll; summed
//   per node that is the node's ingress/egress. 10 s points for the last hour, 1 min points for
//   24 h and daily totals (35 days), saved in KSCREEN_DATA_DIR/sfu-traffic.json.
// - Hybrid rooms: up to `meshMax` people a room is a P2P mesh (no server bandwidth). It moves to
//   the SFU when it grows past that, or when a pair of people can't connect at all (reported by
//   the clients). A room that moved only because of its size goes back to P2P when it shrinks.
import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HEALTH_INTERVAL_MS = 15000;
const HEALTH_TIMEOUT_MS = 4000;
const SAMPLE_MS = 10000;
const RECENT_POINTS = 360; // 1 h of 10 s points
const MINUTE_POINTS = 1440; // 24 h of 1 min points
const DAYS_KEPT = 35;
const TRAFFIC_FRESH_MS = 20000;
// Down this many checks in a row: rooms are moved off the node.
const FAILOVER_CHECKS = 2;
// A room that grew into the SFU goes back to P2P after being small for this long.
const MESH_RETURN_MS = 60000;
// A room that went to the SFU because a pair had no P2P goes back once nobody in it is blocked any
// more (that person left, or their network changed, e.g. 5G -> Wi-Fi), after being clear this long.
const FAIL_RETURN_MS = 15000;
const MIN_SECRET = 32;
const TOTAL = '_total';

// predictP2P: send a room to the SFU as soon as someone joins whose network can't do direct P2P
// with someone else (instead of waiting for the attempt to fail).
const DEFAULT_SETTINGS = { meshMax: 5, meshReturn: true, autoFailover: true, predictP2P: true };

// LiveKit access token (a JWT signed with the API secret).
export function livekitJwt({ key, secret }, { identity = '', name = '', metadata = '', video, ttlS = 6 * 60 * 60 }) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const claims = b64({
    iss: key,
    ...(identity ? { sub: identity } : {}),
    ...(name ? { name: String(name).slice(0, 64) } : {}),
    ...(metadata ? { metadata } : {}),
    nbf: now - 10,
    exp: now + ttlS,
    jti: `${identity || 'admin'}-${now}-${randomBytes(3).toString('hex')}`,
    video
  });
  const signature = createHmac('sha256', secret).update(`${header}.${claims}`).digest('base64url');
  return `${header}.${claims}.${signature}`;
}

// ws://host:7880 -> http://host:7880 (the API lives on the same port as the signaling socket).
function httpBase(url) {
  return String(url).replace(/^ws(s?):\/\//i, 'http$1://').replace(/\/+$/, '');
}

function cleanUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  try {
    const u = new URL(raw);
    if (!['ws:', 'wss:', 'http:', 'https:'].includes(u.protocol)) return '';
    // Clients connect with a websocket URL.
    return raw.replace(/^http(s?):\/\//i, 'ws$1://');
  } catch {
    return '';
  }
}

const cleanText = (value, max) => String(value ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);

export function createSfuManager({ rooms, env, sendJson, readJson, log = console }) {
  const dataDir = env.KSCREEN_DATA_DIR || join(homedir(), '.kscreen');
  const configFile = join(dataDir, 'sfu.json');
  const trafficFile = join(dataDir, 'sfu-traffic.json');

  let config = { nodes: [], settings: { ...DEFAULT_SETTINGS } };
  // nodeId -> { state: 'unknown'|'ok'|'auth'|'down', latencyMs, error, checkedAt, since, fails, rooms, participants }
  const health = new Map();
  // nodeId (or TOTAL) -> [[t, inKbps, outKbps, people], ...]
  const recent = new Map();
  let traffic = { minutes: {}, days: {} };
  let minuteAcc = new Map(); // nodeId -> { n, in, out, people }
  let minuteStart = Math.floor(Date.now() / 60000) * 60000;
  let trafficDirty = false;

  // --- storage ---

  function ensureDir() {
    try { mkdirSync(dataDir, { recursive: true, mode: 0o700 }); } catch { /* exists */ }
  }

  function writeAtomic(file, data) {
    ensureDir();
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
    renameSync(tmp, file);
  }

  function save() {
    try {
      writeAtomic(configFile, config);
    } catch (err) {
      log.error(`[SFU] Não consegui salvar ${configFile}: ${err.message}`);
      throw new Error(`Não consegui salvar a configuração no servidor (${err.code || err.message}).`);
    }
  }

  function load() {
    try {
      if (existsSync(configFile)) {
        const data = JSON.parse(readFileSync(configFile, 'utf8'));
        config = {
          nodes: Array.isArray(data.nodes) ? data.nodes.filter(n => n?.id && n.url && n.secret) : [],
          settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) }
        };
      }
    } catch (err) {
      log.error(`[SFU] ${configFile} ilegível (${err.message}): começando sem nós.`);
    }
    // First start with the old .env.local configuration: it becomes the first node.
    const envUrl = cleanUrl(env.LIVEKIT_URL);
    if (!config.nodes.length && envUrl && env.LIVEKIT_API_KEY && String(env.LIVEKIT_API_SECRET || '').length >= MIN_SECRET && !existsSync(configFile)) {
      config.nodes.push({
        id: `n_${randomBytes(4).toString('hex')}`,
        name: 'Principal',
        url: envUrl,
        key: String(env.LIVEKIT_API_KEY).trim(),
        secret: String(env.LIVEKIT_API_SECRET).trim(),
        enabled: true,
        rev: Date.now(),
        created: Date.now()
      });
      try {
        save();
        log.log(`[SFU] Nó "${envUrl}" do .env.local salvo em ${configFile}. A partir de agora ele é gerenciado no painel admin.`);
      } catch { /* kept in memory */ }
    }
    try {
      if (existsSync(trafficFile)) {
        const data = JSON.parse(readFileSync(trafficFile, 'utf8'));
        traffic = { minutes: data.minutes || {}, days: data.days || {} };
      }
    } catch { /* start a new history */ }
    for (const node of config.nodes) health.set(node.id, { state: 'unknown', fails: 0, since: Date.now() });
  }

  function saveTraffic() {
    if (!trafficDirty) return;
    trafficDirty = false;
    try { writeAtomic(trafficFile, traffic); } catch { /* next minute */ }
  }

  // --- nodes ---

  const nodeById = (id) => config.nodes.find(n => n.id === id) || null;
  const usable = (node) => !!node && node.enabled && health.get(node.id)?.state !== 'down' && health.get(node.id)?.state !== 'auth';

  function roomsOn(nodeId) {
    return [...rooms.values()].filter(r => r.mode === 'sfu' && r.sfuNode === nodeId && r.peers.size > 0);
  }

  function nowTraffic(nodeId) {
    const list = recent.get(nodeId);
    const last = list?.[list.length - 1];
    return last && Date.now() - last[0] < SAMPLE_MS * 2 ? { inKbps: last[1], outKbps: last[2] } : { inKbps: 0, outKbps: 0 };
  }

  // Least loaded healthy node (egress now, then people). `prefer` wins when it is usable (a room
  // recreated after a restart stays where its people already are).
  function pickNode(prefer, exclude) {
    const preferred = nodeById(prefer);
    if (preferred && preferred.id !== exclude && usable(preferred)) return preferred;
    const candidates = config.nodes.filter(n => n.id !== exclude && usable(n));
    if (!candidates.length) return null;
    const load = (n) => {
      const people = roomsOn(n.id).reduce((sum, r) => sum + r.peers.size, 0);
      // Known healthy beats not-yet-checked.
      return [health.get(n.id)?.state === 'ok' ? 0 : 1, nowTraffic(n.id).outKbps, people];
    };
    candidates.sort((a, b) => {
      const x = load(a);
      const y = load(b);
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    });
    return candidates[0];
  }

  const available = () => config.nodes.some(usable);

  function nodeFor(room) {
    let node = nodeById(room.sfuNode);
    // A disabled node keeps its rooms (it only stops taking new ones); a removed one doesn't.
    if (!node) {
      node = pickNode(room.sfuNode);
      room.sfuNode = node?.id || null;
    }
    return node;
  }

  // What clients compare to know they must reconnect: a different node, or the node edited.
  function roomKey(room) {
    if (room.mode !== 'sfu') return null;
    const node = nodeFor(room);
    return node ? `${node.id}@${node.rev}` : null;
  }

  function tokenFor(room, peer, userId) {
    const node = nodeFor(room);
    if (!node) return null;
    const token = livekitJwt(node, {
      identity: peer.id,
      name: peer.name,
      metadata: JSON.stringify({ userId: String(userId) }),
      video: { room: room.id, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true, canUpdateOwnMetadata: false }
    });
    return { url: node.url, token, key: `${node.id}@${node.rev}`, node: node.name };
  }

  function migrateRoom(room, to, why) {
    if (!to || room.sfuNode === to.id) return false;
    const from = nodeById(room.sfuNode);
    room.sfuNode = to.id;
    log.log(`[SFU] Sala ${room.id} movida de ${from?.name || '—'} para ${to.name} (${why}).`);
    return true;
  }

  async function checkNode(node) {
    const h = health.get(node.id) || { state: 'unknown', fails: 0, since: Date.now() };
    const started = Date.now();
    let state = 'down';
    let error = '';
    let info = {};
    try {
      const token = livekitJwt(node, { video: { roomList: true }, ttlS: 60 });
      const res = await fetch(`${httpBase(node.url)}/twirp/livekit.RoomService/ListRooms`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const list = Array.isArray(data.rooms) ? data.rooms : [];
        state = 'ok';
        info = {
          rooms: list.length,
          participants: list.reduce((n, r) => n + (Number(r.num_participants ?? r.numParticipants) || 0), 0)
        };
      } else if (res.status === 401 || res.status === 403) {
        state = 'auth';
        error = 'Chave ou secret recusados pelo nó.';
      } else {
        error = `Respondeu HTTP ${res.status}. O endereço é de um LiveKit?`;
      }
    } catch (err) {
      error = err.name === 'TimeoutError' ? `Sem resposta em ${HEALTH_TIMEOUT_MS / 1000} s.` : `Inacessível (${err.cause?.code || err.message}).`;
    }
    // The node may have been removed or edited while we waited.
    if (!nodeById(node.id)) return null;
    const next = {
      ...h,
      ...info,
      state,
      error,
      latencyMs: Date.now() - started,
      checkedAt: Date.now(),
      fails: state === 'ok' ? 0 : (h.fails || 0) + 1,
      since: state === h.state ? h.since : Date.now()
    };
    if (state !== h.state && h.state !== 'unknown') {
      log.log(`[SFU] Nó ${node.name} (${node.url}): ${h.state} -> ${state}${error ? ` (${error})` : ''}`);
    }
    health.set(node.id, next);
    return next;
  }

  async function checkAll() {
    await Promise.all(config.nodes.map(checkNode));
    if (!config.settings.autoFailover) return;
    for (const node of config.nodes) {
      const h = health.get(node.id);
      if (!h || h.state === 'ok' || h.fails < FAILOVER_CHECKS) continue;
      for (const room of roomsOn(node.id)) {
        const to = pickNode(null, node.id);
        if (to) migrateRoom(room, to, `nó ${node.name} fora do ar`);
      }
    }
  }

  // --- room mode (hybrid) ---

  // Can everyone in this room follow the room into the SFU? (A very old page can't.)
  const allCapable = (room) => [...room.peers.values()].every(p => p.sfuCapable);

  function failedPairs(room) {
    const pairs = [];
    for (const peer of room.peers.values()) {
      for (const other of peer.fails || []) {
        if (room.peers.has(other)) pairs.push([peer.id, other]);
      }
    }
    return pairs;
  }

  // Pairs that won't connect directly, from each side's network type (see probeNetwork in
  // src/webrtc.js). Hole punching needs at least one side whose public port doesn't depend on the
  // destination: a symmetric NAT (4G/5G CGNAT) only meets a cone NAT that lets anyone in, which
  // home routers rarely do, so symmetric + anything is predicted to fail; "blocked" has no public
  // route at all. Same public address = same network (LAN works); IPv6 on both sides may work.
  function predictedPairs(room) {
    if (!config.settings.predictP2P) return [];
    const list = [...room.peers.values()].filter(p => p.net);
    const pairs = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        // Relay forced on a device: never direct, not even on the same network.
        if (a.net.nat === 'relay' || b.net.nat === 'relay') {
          pairs.push([a, b]);
          continue;
        }
        if (a.ip && a.ip === b.ip) continue;
        if (a.net.v6 && b.net.v6) continue;
        const hard = (n) => n.nat === 'symmetric' || n.nat === 'blocked';
        if (hard(a.net) || hard(b.net)) pairs.push([a, b]);
      }
    }
    return pairs;
  }

  const NAT_LABEL = { symmetric: 'NAT simétrico (4G/5G)', blocked: 'rede sem UDP', cone: 'NAT comum', relay: 'conexão via relay forçada' };

  const netKey = (peer) => (peer.net ? `${peer.net.nat}.${peer.net.v6 ? 1 : 0}` : '?');

  // Real failures (both tries failed) are remembered per pair AND per network: once in the SFU the
  // clients stop reporting them, and the room must not go back to P2P while the same two people
  // are on the same networks. A new network (or a re-join, which is a new peer id) clears it.
  function rememberFails(room) {
    room.failHistory ||= new Map();
    for (const [a, b] of failedPairs(room)) {
      const [x, y] = [a, b].sort();
      room.failHistory.set(`${x}|${y}`, { a: x, b: y, netA: netKey(room.peers.get(x)), netB: netKey(room.peers.get(y)) });
    }
    for (const [key, f] of room.failHistory) {
      const pa = room.peers.get(f.a);
      const pb = room.peers.get(f.b);
      if (!pa || !pb || netKey(pa) !== f.netA || netKey(pb) !== f.netB) room.failHistory.delete(key);
    }
  }

  // What keeps this room from working in P2P right now.
  function p2pBlockers(room) {
    return room.failHistory?.size || failedPairs(room).length || predictedPairs(room).length;
  }

  // The same, in words, for the admin panel: why this SFU room isn't back in P2P.
  function holdReason(room) {
    if (room.mode !== 'sfu') return '';
    const { meshMax, meshReturn } = config.settings;
    const name = (id) => room.peers.get(id)?.name || id;
    if (room.modeLock === 'sfu') return 'fixada em SFU no painel';
    if (!meshReturn) return '"Voltar para P2P" está desligado nas regras';
    if (meshMax === 0) return 'limite do P2P em 0 (sempre SFU)';
    if (room.modeCause === 'size' ? room.peers.size >= meshMax : room.peers.size > meshMax) return `${room.peers.size} pessoas (P2P vai até ${room.modeCause === 'size' ? meshMax - 1 : meshMax} para voltar)`;
    const predicted = predictedPairs(room);
    if (predicted.length) {
      const who = [...new Set(predicted.flat().filter(p => p.net.nat !== 'cone'))];
      return `rede sem P2P: ${who.map(p => `${p.name} (${NAT_LABEL[p.net.nat]})`).join(', ')}`;
    }
    if (room.failHistory?.size) return `falha real de P2P entre ${[...room.failHistory.values()].map(f => `${name(f.a)} e ${name(f.b)}`).join(', ')} (vale até alguém trocar de rede ou sair)`;
    if (!['size', 'fail', 'restored'].includes(room.modeCause)) return `entrou no SFU por "${room.modeReason || room.modeCause || '?'}"`;
    if (room.lowSince) return `voltando para P2P em ${Math.max(0, Math.ceil(((room.modeCause === 'size' ? MESH_RETURN_MS : FAIL_RETURN_MS) - (Date.now() - room.lowSince)) / 1000))} s`;
    return 'verificando…';
  }

  function modeOnCreate(capable, wanted) {
    if (!capable || !available()) return 'mesh';
    // After a server restart the room comes back in the mode its people are using.
    if (wanted === 'sfu' || wanted === 'mesh') return wanted;
    return config.settings.meshMax > 0 ? 'mesh' : 'sfu';
  }

  // cause: 'size' | 'fail' | 'always' | 'admin' | 'down' | 'small' (only 'size' goes back to P2P).
  function setMode(room, mode, reason, cause) {
    if (room.mode === mode) return false;
    room.mode = mode;
    room.modeReason = reason;
    room.modeCause = cause;
    room.modeSince = Date.now();
    room.lowSince = 0;
    if (mode === 'sfu') {
      const node = pickNode(room.sfuNode);
      room.sfuNode = node?.id || null;
    }
    log.log(`[SFU] Sala ${room.id} agora em ${mode === 'sfu' ? 'SFU' : 'P2P'} (${reason}).`);
    return true;
  }

  // Called on join, on every poll that reports failures and on the sampler tick.
  function evaluate(room) {
    if (!room.peers.size) return false;
    const { meshMax, meshReturn } = config.settings;
    rememberFails(room);
    if (room.modeLock) {
      if (room.modeLock === 'sfu' && (!available() || !allCapable(room))) return false;
      return setMode(room, room.modeLock, 'definido no painel admin', 'admin');
    }
    const people = room.peers.size;
    if (room.mode !== 'sfu') {
      if (!available() || !allCapable(room)) return false;
      if (meshMax === 0) return setMode(room, 'sfu', 'limite do P2P em 0 (sempre SFU)', 'always');
      if (people > meshMax) return setMode(room, 'sfu', `${people} pessoas (P2P vai até ${meshMax})`, 'size');
      const pairs = failedPairs(room);
      if (pairs.length) {
        const name = (id) => room.peers.get(id)?.name || id;
        return setMode(room, 'sfu', `sem P2P entre ${pairs.slice(0, 3).map(([a, b]) => `${name(a)} e ${name(b)}`).join(', ')}`, 'fail');
      }
      const predicted = predictedPairs(room);
      if (predicted.length) {
        const who = [...new Set(predicted.flat().filter(p => p.net.nat !== 'cone'))].slice(0, 3);
        return setMode(room, 'sfu', `previsto sem P2P: ${who.map(p => `${p.name} (${NAT_LABEL[p.net.nat]})`).join(', ')}`, 'fail');
      }
      return false;
    }
    // In the SFU: no node left that works -> P2P is better than nothing.
    if (!available()) {
      room.downSince ||= Date.now();
      if (Date.now() - room.downSince > 30000) return setMode(room, 'mesh', 'nenhum nó SFU disponível', 'down');
      return false;
    }
    room.downSince = 0;
    // Back to P2P when it would work again:
    //  - went in because of its size: once small for a while (one less than the limit, so a room
    //    hovering at the limit doesn't flip back and forth);
    //  - went in because someone had no P2P: once nobody is blocked (left, or changed network).
    // Either way only if nobody in it is blocked now.
    // "restored": recreated in the SFU after a server restart, its old reason is unknown.
    const cause = room.modeCause;
    const small = cause === 'size' ? people < meshMax : people <= meshMax;
    if (meshReturn && meshMax > 0 && ['size', 'fail', 'restored'].includes(cause) && small && !p2pBlockers(room)) {
      room.lowSince ||= Date.now();
      if (Date.now() - room.lowSince > (cause === 'fail' ? FAIL_RETURN_MS : MESH_RETURN_MS)) {
        const why = cause === 'size' ? `voltou a ${people} pessoas` : cause === 'restored' ? 'P2P possível (sala recriada após reinício do servidor)' : 'P2P possível de novo (quem não tinha saiu ou trocou de rede)';
        return setMode(room, 'mesh', why, 'small');
      }
    } else {
      room.lowSince = 0;
    }
    return false;
  }

  // --- traffic ---

  function reportTraffic(peer, up, down) {
    const u = Math.max(0, Math.min(1e6, Math.round(Number(up) || 0)));
    const d = Math.max(0, Math.min(1e6, Math.round(Number(down) || 0)));
    peer.sfuTraffic = { up: u, down: d, at: Date.now() };
  }

  function sample() {
    const now = Date.now();
    const sums = new Map(config.nodes.map(n => [n.id, { in: 0, out: 0, people: 0 }]));
    const total = { in: 0, out: 0, people: 0 };
    for (const room of rooms.values()) {
      if (room.mode !== 'sfu' || !room.sfuNode) continue;
      const s = sums.get(room.sfuNode);
      if (!s) continue;
      for (const peer of room.peers.values()) {
        s.people++;
        const t = peer.sfuTraffic;
        if (!t || now - t.at > TRAFFIC_FRESH_MS) continue;
        // What a client sends goes INTO the node; what it receives comes OUT of it.
        s.in += t.up;
        s.out += t.down;
      }
    }
    for (const s of sums.values()) {
      total.in += s.in;
      total.out += s.out;
      total.people += s.people;
    }
    sums.set(TOTAL, total);
    const day = dayKey(now);
    for (const [id, s] of sums) {
      const list = recent.get(id) || [];
      list.push([now, s.in, s.out, s.people]);
      if (list.length > RECENT_POINTS) list.splice(0, list.length - RECENT_POINTS);
      recent.set(id, list);
      const acc = minuteAcc.get(id) || { n: 0, in: 0, out: 0, people: 0 };
      acc.n++;
      acc.in += s.in;
      acc.out += s.out;
      acc.people = Math.max(acc.people, s.people);
      minuteAcc.set(id, acc);
      // kbps over SAMPLE_MS -> bytes
      const bytes = Math.round((s.in + s.out) * 1000 / 8 * SAMPLE_MS / 1000);
      if (bytes) {
        const days = traffic.days[id] ||= {};
        days[day] = (days[day] || 0) + bytes;
        trafficDirty = true;
      }
    }
    const minute = Math.floor(now / 60000) * 60000;
    if (minute !== minuteStart) {
      for (const [id, acc] of minuteAcc) {
        const list = traffic.minutes[id] ||= [];
        list.push([minuteStart, Math.round(acc.in / acc.n), Math.round(acc.out / acc.n), acc.people]);
        if (list.length > MINUTE_POINTS) list.splice(0, list.length - MINUTE_POINTS);
      }
      minuteAcc = new Map();
      minuteStart = minute;
      // Forget nodes that were removed, and old days.
      const keep = new Set([TOTAL, ...config.nodes.map(n => n.id)]);
      for (const id of Object.keys(traffic.minutes)) if (!keep.has(id)) delete traffic.minutes[id];
      for (const id of Object.keys(traffic.days)) {
        if (!keep.has(id)) { delete traffic.days[id]; continue; }
        const days = Object.keys(traffic.days[id]).sort();
        for (const d of days.slice(0, Math.max(0, days.length - DAYS_KEPT))) delete traffic.days[id][d];
      }
      trafficDirty = true;
      saveTraffic();
    }
    for (const room of rooms.values()) evaluate(room);
  }

  // --- admin API ---

  function nodeView(node) {
    const h = health.get(node.id) || { state: 'unknown' };
    const onNode = roomsOn(node.id);
    const days = traffic.days[node.id] || {};
    const today = dayKey(Date.now());
    return {
      id: node.id,
      name: node.name,
      url: node.url,
      key: node.key,
      // The secret never leaves the server: only its end, so the admin knows which one it is.
      secretHint: `…${node.secret.slice(-4)}`,
      enabled: node.enabled,
      created: node.created,
      health: {
        state: h.state,
        error: h.error || '',
        latencyMs: h.latencyMs ?? null,
        checkedAt: h.checkedAt || null,
        since: h.since || null,
        liveRooms: h.rooms ?? null,
        liveParticipants: h.participants ?? null
      },
      now: nowTraffic(node.id),
      todayBytes: days[today] || 0,
      days,
      rooms: onNode.map(r => ({ id: r.id, people: r.peers.size, reason: r.modeReason || '', since: r.modeSince || r.created })),
      people: onNode.reduce((n, r) => n + r.peers.size, 0)
    };
  }

  function series(id, range) {
    if (range === '24h') return traffic.minutes[id] || [];
    return recent.get(id) || [];
  }

  function overview(range) {
    const nodes = config.nodes.map(nodeView);
    const totalDays = traffic.days[TOTAL] || {};
    const live = [...rooms.values()].filter(r => r.peers.size > 0);
    return {
      settings: config.settings,
      storage: configFile,
      range,
      nodes,
      series: Object.fromEntries([TOTAL, ...config.nodes.map(n => n.id)].map(id => [id, series(id, range)])),
      total: {
        now: nowTraffic(TOTAL),
        todayBytes: totalDays[dayKey(Date.now())] || 0,
        days: totalDays,
        healthy: nodes.filter(n => n.health.state === 'ok').length,
        sfuRooms: live.filter(r => r.mode === 'sfu').length,
        meshRooms: live.filter(r => r.mode !== 'sfu').length,
        sfuPeople: live.filter(r => r.mode === 'sfu').reduce((n, r) => n + r.peers.size, 0)
      },
      rooms: live.map(r => ({
        id: r.id,
        people: r.peers.size,
        mode: r.mode || 'mesh',
        reason: r.modeReason || '',
        lock: r.modeLock || null,
        node: r.mode === 'sfu' ? r.sfuNode : null,
        // Network type of each person (no addresses): explains predicted SFU rooms.
        nets: [...r.peers.values()].map(p => [p.name, p.net ? `${p.net.nat}${p.net.v6 ? '+v6' : ''}` : '?']),
        failedPairs: failedPairs(r).map(([a, b]) => [r.peers.get(a)?.name || a, r.peers.get(b)?.name || b]),
        hold: holdReason(r)
      }))
    };
  }

  const fail = (res, status, error) => {
    sendJson(res, status, { error });
    return true;
  };

  // Handles /api/admin/sfu*. The caller already checked that the account is an admin.
  async function admin(req, res, url) {
    const path = url.pathname;
    if (!path.startsWith('/api/admin/sfu')) return false;

    if (req.method === 'GET' && path === '/api/admin/sfu') {
      sendJson(res, 200, overview(url.searchParams.get('range') === '24h' ? '24h' : '1h'));
      return true;
    }
    if (req.method !== 'POST') return fail(res, 405, 'Método não permitido');
    const data = await readJson(req).catch(() => null);
    if (!data || typeof data !== 'object') return fail(res, 400, 'Dados inválidos.');

    // Add a node (it is tested before the answer, so the panel shows right away if it works).
    if (path === '/api/admin/sfu/nodes') {
      const nodeUrl = cleanUrl(data.url);
      const secret = String(data.secret || '').trim();
      if (!nodeUrl) return fail(res, 400, 'Endereço inválido. Use wss://sfu.seudominio.com (ou ws://IP:7880).');
      if (secret.length < MIN_SECRET) return fail(res, 400, `O secret do LiveKit tem pelo menos ${MIN_SECRET} caracteres.`);
      if (config.nodes.some(n => n.url === nodeUrl)) return fail(res, 409, 'Já existe um nó com esse endereço.');
      const node = {
        id: `n_${randomBytes(4).toString('hex')}`,
        name: cleanText(data.name, 40) || new URL(httpBase(nodeUrl)).hostname,
        url: nodeUrl,
        key: cleanText(data.key, 64) || 'kscreen',
        secret,
        enabled: data.enabled !== false,
        rev: Date.now(),
        created: Date.now()
      };
      config.nodes.push(node);
      health.set(node.id, { state: 'unknown', fails: 0, since: Date.now() });
      save();
      log.log(`[SFU] Nó adicionado: ${node.name} (${node.url})`);
      await checkNode(node);
      sendJson(res, 200, { node: nodeView(node) });
      return true;
    }

    const nodeMatch = /^\/api\/admin\/sfu\/nodes\/(n_[a-z0-9]+)(?:\/(test|delete))?$/.exec(path);
    if (nodeMatch) {
      const node = nodeById(nodeMatch[1]);
      if (!node) return fail(res, 404, 'Nó não encontrado.');
      const action = nodeMatch[2];
      if (action === 'test') {
        await checkNode(node);
        sendJson(res, 200, { node: nodeView(node) });
        return true;
      }
      if (action === 'delete') {
        const to = nodeById(data.to) || pickNode(null, node.id);
        const moved = roomsOn(node.id);
        config.nodes = config.nodes.filter(n => n.id !== node.id);
        health.delete(node.id);
        recent.delete(node.id);
        for (const room of moved) {
          if (to) migrateRoom(room, to, `nó ${node.name} removido`);
          else room.sfuNode = null;
        }
        save();
        log.log(`[SFU] Nó removido: ${node.name}`);
        sendJson(res, 200, { ok: true, moved: moved.length, to: to?.name || null });
        return true;
      }
      // Edit. An empty secret keeps the current one. Address/key/secret changes bump the rev, so
      // everyone on this node reconnects with a new token right away.
      const next = { ...node };
      if ('name' in data) next.name = cleanText(data.name, 40) || node.name;
      if ('url' in data) {
        const nodeUrl = cleanUrl(data.url);
        if (!nodeUrl) return fail(res, 400, 'Endereço inválido. Use wss://sfu.seudominio.com (ou ws://IP:7880).');
        if (config.nodes.some(n => n.id !== node.id && n.url === nodeUrl)) return fail(res, 409, 'Já existe um nó com esse endereço.');
        next.url = nodeUrl;
      }
      if ('key' in data) next.key = cleanText(data.key, 64) || 'kscreen';
      if (data.secret) {
        const secret = String(data.secret).trim();
        if (secret.length < MIN_SECRET) return fail(res, 400, `O secret do LiveKit tem pelo menos ${MIN_SECRET} caracteres.`);
        next.secret = secret;
      }
      if ('enabled' in data) next.enabled = !!data.enabled;
      const reconnect = next.url !== node.url || next.key !== node.key || next.secret !== node.secret;
      if (reconnect) next.rev = Date.now();
      Object.assign(node, next);
      save();
      if (reconnect) health.set(node.id, { state: 'unknown', fails: 0, since: Date.now() });
      await checkNode(node);
      log.log(`[SFU] Nó editado: ${node.name}${reconnect ? ' (salas reconectando)' : ''}`);
      sendJson(res, 200, { node: nodeView(node), reconnecting: reconnect ? roomsOn(node.id).length : 0 });
      return true;
    }

    // Move rooms: one room ({ roomId, to }) or everyone on a node ({ from, to }).
    if (path === '/api/admin/sfu/migrate') {
      const to = nodeById(data.to);
      if (!to) return fail(res, 400, 'Escolha o nó de destino.');
      if (!usable(to)) return fail(res, 409, `O nó ${to.name} não está saudável ou está desativado.`);
      let list = [];
      if (data.roomId) {
        const room = rooms.get(String(data.roomId));
        if (!room || room.mode !== 'sfu') return fail(res, 404, 'Sala SFU não encontrada.');
        list = [room];
      } else if (data.from) {
        list = roomsOn(String(data.from));
      } else {
        list = [...rooms.values()].filter(r => r.mode === 'sfu' && r.peers.size > 0);
      }
      let moved = 0;
      for (const room of list) if (migrateRoom(room, to, 'admin')) moved++;
      sendJson(res, 200, { ok: true, moved });
      return true;
    }

    // Force a room into a mode (or back to automatic: mode null).
    if (path === '/api/admin/sfu/room-mode') {
      const room = rooms.get(String(data.roomId || ''));
      if (!room) return fail(res, 404, 'Sala não encontrada.');
      const mode = data.mode === 'sfu' || data.mode === 'mesh' ? data.mode : null;
      if (mode === 'sfu' && !available()) return fail(res, 409, 'Nenhum nó SFU saudável.');
      if (mode === 'sfu' && !allCapable(room)) return fail(res, 409, 'Alguém nesta sala está com uma versão antiga do kScreen.');
      room.modeLock = mode;
      // Back to automatic: a room the admin put in the SFU may return to P2P like a big one.
      if (!mode && room.modeCause === 'admin') room.modeCause = 'size';
      evaluate(room);
      sendJson(res, 200, { ok: true, mode: room.mode });
      return true;
    }

    if (path === '/api/admin/sfu/settings') {
      const next = { ...config.settings };
      if ('meshMax' in data) {
        const n = Math.floor(Number(data.meshMax));
        if (!Number.isFinite(n) || n < 0 || n > 16) return fail(res, 400, 'O limite do P2P vai de 0 (sempre SFU) a 16.');
        next.meshMax = n;
      }
      if ('meshReturn' in data) next.meshReturn = !!data.meshReturn;
      if ('autoFailover' in data) next.autoFailover = !!data.autoFailover;
      if ('predictP2P' in data) next.predictP2P = !!data.predictP2P;
      config.settings = next;
      save();
      for (const room of rooms.values()) evaluate(room);
      sendJson(res, 200, { settings: next });
      return true;
    }

    return fail(res, 404, 'Rota não encontrada');
  }

  load();
  const timers = [
    setInterval(() => { checkAll().catch(() => {}); }, HEALTH_INTERVAL_MS),
    setInterval(sample, SAMPLE_MS)
  ];
  for (const t of timers) t.unref?.();
  checkAll().catch(() => {});

  return {
    available,
    modeOnCreate,
    evaluate,
    roomKey,
    tokenFor,
    reportTraffic,
    nodeName: (id) => nodeById(id)?.name || null,
    admin,
    flush: saveTraffic
  };
}
