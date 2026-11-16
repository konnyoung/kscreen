// Room text chat (Discord-like): messages, image uploads, reactions, replies, typing and
// YouTube link previews. Everything lives in memory with the room and disappears with it.
//
// Delivery: clients long-poll /api/room/chat/events?since=<version>. Every change (new, edited,
// deleted message, reaction, embed) bumps room.chat.version and stamps the message with it, so a
// client only ever receives what changed since the last version it saw.
import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_MESSAGES = 500;
const MAX_CONTENT = 2000;
const MAX_ATTACHMENTS = 10;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const P2P_MAX_FILE_BYTES = 25 * 1024 * 1024;
const cleanPeerIdLocal = (v) => String(v || '').replace(/[^\w-]/g, '').slice(0, 64);
const ROOM_FILE_BUDGET = 100 * 1024 * 1024;
const LONG_POLL_MS = 25000;
// History restore after a server restart (see "restore" below): per request.
const MAX_RESTORE = 100;

// Stable JSON (sorted keys) so the signature doesn't depend on key order.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
const MAX_WAITERS = 64;
const TYPING_MS = 8000;
const MAX_REACTIONS = 20;
const RATE_WINDOW_MS = 5000;
const RATE_MAX = 6;

const id = () => randomBytes(9).toString('base64url');

function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('too large'), { tooLarge: true }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function cleanContent(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function cleanEmoji(value) {
  const s = String(value || '');
  // One emoji grapheme (pictographic, flags or keycaps), at most a handful of code points.
  return s.length <= 16 && /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(s) && !/[\s<>]/.test(s) ? s : '';
}

const YT_RE = /https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?[^\s]*v=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})[^\s]*/i;

export function createChat({ rooms, normalizeRoomId, cleanPeerId, sendJson, readJson, env, secret }) {
  // Every message carries an HMAC of its content (sig). After a restart the server's memory is
  // empty, but the people still in the call have the history: they send it back ("restore") and
  // only messages with a valid signature are accepted, so nobody can forge someone else's.
  // Needs a fixed SESSION_SECRET (a temporary one changes on every restart: nothing restores).
  const hmacKey = secret || randomBytes(32).toString('hex');
  const signOf = (msg) => {
    const { version, sig, ...body } = msg;
    return createHmac('sha256', hmacKey).update(canonical(body)).digest('base64url');
  };
  const validSig = (msg) => {
    if (typeof msg?.sig !== 'string') return false;
    const a = Buffer.from(msg.sig);
    const b = Buffer.from(signOf(msg));
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const giphyKey = env.GIPHY_API_KEY || '';
  const oembedCache = new Map(); // videoId -> embed | null

  function chatOf(room) {
    room.chat ??= {
      // Starts at the clock: after a restart it's above any version a client saw before.
      version: Date.now(),
      // Changes on every server start: a client that sees it change sends its history back.
      epoch: randomBytes(6).toString('hex'),
      messages: [],
      relay: new Map(), // hash -> { buf, type, at }: P2P images passed through the server as a last resort
      relayBytes: 0,
      wants: new Map(), // hash -> time someone asked for a relayed copy
      files: new Map(), // fileId -> { buf, type, name, size, width, height, ownerId, used, at }
      fileBytes: 0,
      waiters: new Set(),
      typing: new Map(), // userId -> { name, until }
      rate: new Map() // userId -> timestamps
    };
    return room.chat;
  }

  function wake(chat) {
    for (const done of chat.waiters) done();
    chat.waiters.clear();
  }

  function touch(chat, msg) {
    msg.version = ++chat.version;
    msg.sig = signOf(msg);
    wake(chat);
  }

  function typingList(chat, exceptId) {
    const now = Date.now();
    const out = [];
    for (const [userId, t] of chat.typing) {
      if (t.until < now) chat.typing.delete(userId);
      else if (userId !== exceptId) out.push({ id: userId, name: t.name });
    }
    return out;
  }

  const publicMessage = (m) => m;

  function limited(chat, userId) {
    const now = Date.now();
    const list = (chat.rate.get(userId) || []).filter(t => now - t < RATE_WINDOW_MS);
    if (list.length >= RATE_MAX) return true;
    list.push(now);
    chat.rate.set(userId, list);
    return false;
  }

  function dropFile(chat, fileId) {
    const f = chat.files.get(fileId);
    if (!f) return;
    chat.fileBytes -= f.size;
    chat.files.delete(fileId);
  }

  // Oldest files go first when the room runs out of space (their messages show "unavailable").
  const RELAY_TTL_MS = 5 * 60 * 1000;
  const RELAY_BUDGET = 100 * 1024 * 1024;

  function findP2PAttachment(chat, hash) {
    if (!/^[0-9a-f]{64}$/.test(hash)) return null;
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      const a = chat.messages[i].attachments?.find(x => x.p2p && x.hash === hash);
      if (a) return a;
    }
    return null;
  }

  function pruneRelay(chat, incoming = 0) {
    const now = Date.now();
    for (const [h, f] of chat.relay) {
      if (now - f.at < RELAY_TTL_MS && chat.relayBytes + incoming <= RELAY_BUDGET) break;
      chat.relay.delete(h);
      chat.relayBytes -= f.buf.length;
    }
  }

  function wantList(chat) {
    pruneRelay(chat);
    const now = Date.now();
    const out = [];
    for (const [h, at] of chat.wants) {
      if (now - at > 60000) chat.wants.delete(h);
      else out.push(h);
    }
    return out;
  }

  function makeRoom(chat, bytes) {
    const dropped = new Set();
    for (const [fileId] of chat.files) {
      if (chat.fileBytes + bytes <= ROOM_FILE_BUDGET) break;
      dropFile(chat, fileId);
      dropped.add(fileId);
    }
    if (!dropped.size) return;
    // Their messages stay, with the image marked as removed (everyone's view updates).
    for (const msg of chat.messages) {
      let changed = false;
      for (const a of msg.attachments || []) {
        if (dropped.has(a.id) && !a.expired) {
          a.expired = true;
          changed = true;
        }
      }
      if (changed) touch(chat, msg);
    }
  }

  async function youtubeEmbed(url, videoId) {
    if (oembedCache.has(videoId)) return oembedCache.get(videoId);
    let embed = null;
    try {
      const ctrl = AbortSignal.timeout(4000);
      const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`, { signal: ctrl });
      if (res.ok) {
        const data = await res.json();
        embed = {
          type: 'youtube',
          url,
          videoId,
          title: String(data.title || '').slice(0, 200),
          author: String(data.author_name || '').slice(0, 100),
          authorUrl: /^https:\/\/www\.youtube\.com\//.test(data.author_url || '') ? data.author_url : null
        };
      }
    } catch { /* no preview */ }
    if (oembedCache.size > 500) oembedCache.clear();
    oembedCache.set(videoId, embed);
    return embed;
  }

  // ---- Generic link previews (OpenGraph / Twitter cards / <title>), like Discord.
  // The server fetches the page, so private and local addresses are refused (no SSRF), every
  // redirect hop is checked again, and only the start of the HTML is read.
  const linkCache = new Map(); // url -> embed | null

  function privateIp(ip) {
    if (isIP(ip) === 6) {
      const v = ip.toLowerCase();
      if (v.startsWith('::ffff:')) return privateIp(v.slice(7));
      return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('64:ff9b') || v.startsWith('2001:db8');
    }
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
  }

  async function safeUrl(raw) {
    let u;
    try { u = new URL(raw); } catch { return null; }
    if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
    if (u.port && !['80', '443', '8080', '8443'].includes(u.port)) return null;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!host || host === 'localhost' || /\.(localhost|local|internal)$/.test(host)) return null;
    try {
      const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
      if (!addrs.length || addrs.some(a => privateIp(a.address))) return null;
    } catch { return null; }
    return u;
  }

  const decodeHtml = (t) => String(t || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ''; } })
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();

  const ATTR_RE = (n) => new RegExp(`\\b${n}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');

  function parseMeta(html) {
    const meta = {};
    for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
      const attr = (n) => { const m = ATTR_RE(n).exec(tag); return m ? (m[1] ?? m[2] ?? m[3]) : undefined; };
      const key = (attr('property') || attr('name') || attr('itemprop') || '').toLowerCase();
      const content = attr('content');
      if (key && content !== undefined && !(key in meta)) meta[key] = decodeHtml(content);
    }
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    if (title) meta['<title>'] = decodeHtml(title[1]);
    return meta;
  }

  async function linkEmbed(url) {
    if (linkCache.has(url)) return linkCache.get(url);
    let embed = null;
    try {
      let target = await safeUrl(url);
      let res = null;
      for (let hop = 0; target && hop < 4; hop++) {
        res = await fetch(target, {
          redirect: 'manual',
          signal: AbortSignal.timeout(5000),
          headers: {
            // Many sites only hand their cards to known link-preview bots.
            'User-Agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
            Accept: 'text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.5',
            'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
          }
        });
        const location = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && location) {
          res.body?.cancel().catch(() => {});
          res = null;
          target = await safeUrl(new URL(location, target).href);
          continue;
        }
        break;
      }
      if (res?.ok) {
        const type = (res.headers.get('content-type') || '').toLowerCase();
        if (type.startsWith('image/')) {
          res.body?.cancel().catch(() => {});
          embed = { type: 'image', url, image: target.href };
        } else if (type.includes('html') && res.body) {
          const reader = res.body.getReader();
          const chunks = [];
          let size = 0;
          while (size < 512 * 1024) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            size += value.length;
            // The cards live in <head>: stop once it is over.
            if (/<\/head>|<body[\s>]/i.test(Buffer.from(value).toString('latin1'))) break;
          }
          reader.cancel().catch(() => {});
          const m = parseMeta(Buffer.concat(chunks).toString('utf8'));
          const pick = (...keys) => keys.map(k => m[k]).find(Boolean) || '';
          const abs = (v) => {
            if (!v) return '';
            try { const u = new URL(v, target); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch { return ''; }
          };
          const title = pick('og:title', 'twitter:title', '<title>').slice(0, 256);
          const description = pick('og:description', 'twitter:description', 'description').slice(0, 350);
          const image = abs(pick('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'));
          const site = pick('og:site_name', 'application-name').slice(0, 100) || target.hostname.replace(/^www\./, '');
          const color = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(m['theme-color'] || '') ? m['theme-color'] : null;
          const large = m['twitter:card'] === 'summary_large_image'
            || (Number(m['og:image:width']) >= 400 && Number(m['og:image:width']) >= Number(m['og:image:height'] || 0));
          if (title || description || image) embed = { type: 'link', url, site, title, description, image, color, large };
        } else {
          res.body?.cancel().catch(() => {});
        }
      } else {
        res?.body?.cancel().catch(() => {});
      }
    } catch { /* no preview */ }
    if (linkCache.size > 1000) linkCache.clear();
    linkCache.set(url, embed);
    return embed;
  }

  // Links inside <...> are not previewed (Discord's way to suppress an embed); up to 3 per message.
  const LINK_RE = /(^|[^<])(https?:\/\/[^\s<>"]+[^\s<>"'.,;:!?)\]])/gi;

  function addEmbeds(chat, msg) {
    const jobs = [];
    const seen = new Set();
    const text = msg.content.replace(/```[\s\S]*?```|`[^`]*`/g, ' ');
    for (const m of text.matchAll(LINK_RE)) {
      const url = m[2];
      if (seen.has(url) || seen.size >= 3) continue;
      seen.add(url);
      const yt = YT_RE.exec(url);
      jobs.push(yt ? youtubeEmbed(url, yt[1]) : linkEmbed(url));
    }
    if (!jobs.length) return;
    const content = msg.content;
    Promise.all(jobs.map(j => j.catch(() => null))).then((list) => {
      const embeds = list.filter(Boolean);
      if (!embeds.length || msg.deleted || msg.content !== content || !chat.messages.includes(msg)) return;
      msg.embeds = embeds;
      touch(chat, msg);
    });
  }


  // Resolves room + this user's own peer. GET: query string; POST: JSON body (or query for uploads).
  function context(user, roomId, peerId) {
    const room = rooms.get(normalizeRoomId(roomId));
    const peer = room?.peers.get(cleanPeerId(peerId));
    if (!peer || peer.userId !== user.id) return null;
    return { room, chat: chatOf(room), peer };
  }

  function memberOf(user, roomId) {
    const room = rooms.get(normalizeRoomId(roomId));
    if (!room) return null;
    for (const p of room.peers.values()) if (p.userId === user.id) return room;
    return null;
  }

  async function gifs(res, q) {
    if (!giphyKey) return sendJson(res, 503, { error: 'Busca de GIFs não configurada (GIPHY_API_KEY).', disabled: true });
    const query = String(q || '').trim().slice(0, 50);
    const endpoint = query
      ? `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(giphyKey)}&q=${encodeURIComponent(query)}&limit=30&rating=pg-13&lang=pt`
      : `https://api.giphy.com/v1/gifs/trending?api_key=${encodeURIComponent(giphyKey)}&limit=30&rating=pg-13`;
    try {
      const r = await fetch(endpoint, { signal: AbortSignal.timeout(6000) });
      if (!r.ok) throw new Error(String(r.status));
      const data = await r.json();
      const list = (data.data || []).map((g) => {
        const orig = g.images?.original || {};
        const small = g.images?.fixed_width || orig;
        const clean = (u) => String(u || '').split('?')[0];
        return {
          id: g.id,
          url: clean(orig.url),
          preview: clean(small.webp || small.url),
          width: Number(small.width) || 200,
          height: Number(small.height) || 150,
          title: String(g.title || '').slice(0, 100)
        };
      }).filter(g => /^https:\/\/media\d*\.giphy\.com\//.test(g.url));
      sendJson(res, 200, { gifs: list });
    } catch {
      sendJson(res, 502, { error: 'Não foi possível buscar GIFs agora.' });
    }
  }

  // Returns true when the request was a chat route.
  return async function handle(req, res, url, user) {
    const path = url.pathname;
    if (!path.startsWith('/api/room/chat/')) return false;
    const route = path.slice('/api/room/chat/'.length);
    const q = url.searchParams;

    // Files are fetched by <img> tags: membership is checked with the session only.
    if (req.method === 'GET' && route.startsWith('file/')) {
      const [, roomId, fileId] = route.split('/');
      const room = memberOf(user, roomId);
      const file = room?.chat?.files.get(fileId);
      if (!file) {
        res.statusCode = 404;
        res.end();
        return true;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', file.type);
      res.setHeader('Content-Length', file.size);
      res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'");
      res.end(file.buf);
      return true;
    }

    if (req.method === 'GET' && route === 'gifs') {
      await gifs(res, q.get('q'));
      return true;
    }

    // ---- Relay fallback for P2P images: when nobody can deliver a picture over WebRTC (no direct
    // route and no TURN), someone who has it uploads it here for a few minutes. Only files that a
    // message in the room points to, checked against their SHA-256.
    if (req.method === 'POST' && route === 'relay-put') {
      const ctx = context(user, q.get('roomId'), q.get('peerId'));
      if (!ctx) return sendJson(res, 404, { error: 'Sala não encontrada' }), true;
      const { chat } = ctx;
      const hash = String(q.get('hash') || '');
      const att = findP2PAttachment(chat, hash);
      if (!att) return sendJson(res, 404, { error: 'Arquivo desconhecido' }), true;
      if (chat.relay.has(hash)) return sendJson(res, 200, { ok: true }), true;
      let buf;
      try { buf = await readRaw(req, P2P_MAX_FILE_BYTES); } catch { return sendJson(res, 413, { error: 'Grande demais' }), true; }
      if (createHash('sha256').update(buf).digest('hex') !== hash) return sendJson(res, 400, { error: 'Conteúdo não confere' }), true;
      pruneRelay(chat, buf.length);
      chat.relay.set(hash, { buf, type: att.type, at: Date.now() });
      chat.relayBytes += buf.length;
      chat.wants.delete(hash);
      wake(chat);
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (req.method === 'GET' && route === 'relay-file') {
      const ctx = context(user, q.get('roomId'), q.get('peerId'));
      if (!ctx) return sendJson(res, 404, { error: 'Sala não encontrada' }), true;
      const f = ctx.chat.relay.get(String(q.get('hash') || ''));
      if (!f) return sendJson(res, 404, { error: 'Ainda não disponível' }), true;
      res.writeHead(200, { 'Content-Type': f.type, 'Content-Length': f.buf.length, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' });
      res.end(f.buf);
      return true;
    }

    if (req.method === 'POST' && route === 'upload') {
      const ctx = context(user, q.get('roomId'), q.get('peerId'));
      if (!ctx) return sendJson(res, 404, { error: 'Sala não encontrada' }), true;
      let buf;
      try {
        buf = await readRaw(req, MAX_FILE_BYTES);
      } catch (err) {
        return sendJson(res, 413, { error: 'Imagem grande demais (máximo 8 MB).' }), true;
      }
      const type = sniffImage(buf);
      if (!type) return sendJson(res, 415, { error: 'Envie imagens PNG, JPG, GIF ou WebP.' }), true;
      const { chat } = ctx;
      makeRoom(chat, buf.length);
      const fileId = id();
      const dim = (v) => Math.max(1, Math.min(20000, Math.floor(Number(v)) || 0)) || null;
      const name = String(q.get('name') || 'imagem').replace(/[^\w.\- ]/g, '_').slice(0, 80) || 'imagem';
      chat.files.set(fileId, {
        buf, type, name, size: buf.length,
        width: dim(q.get('w')), height: dim(q.get('h')),
        ownerId: user.id, used: false, at: Date.now()
      });
      chat.fileBytes += buf.length;
      sendJson(res, 200, { id: fileId });
      return true;
    }

    if (req.method === 'GET' && (route === 'events' || route === 'history')) {
      const ctx = context(user, q.get('roomId'), q.get('peerId'));
      if (!ctx) return sendJson(res, 404, { error: 'Sala não encontrada' }), true;
      const { chat } = ctx;

      if (route === 'history') {
        const before = q.get('before');
        const limit = Math.min(100, Math.max(1, Number(q.get('limit')) || 50));
        let end = chat.messages.length;
        if (before) {
          const i = chat.messages.findIndex(m => m.id === before);
          if (i >= 0) end = i;
        }
        const list = chat.messages.slice(0, end).filter(m => !m.deleted);
        const page = list.slice(-limit);
        sendJson(res, 200, {
          messages: page.map(publicMessage),
          hasMore: list.length > page.length,
          version: chat.version,
          epoch: chat.epoch
        });
        return true;
      }

      let since = Number(q.get('since')) || 0;
      // A version from before a restart that's somehow ahead of ours: send everything.
      if (since > chat.version) since = 0;
      const collect = () => chat.messages.filter(m => m.version > since);
      if (since >= chat.version && chat.waiters.size < MAX_WAITERS) {
        await new Promise((resolve) => {
          const done = () => { clearTimeout(timer); resolve(); };
          const timer = setTimeout(() => { chat.waiters.delete(done); resolve(); }, LONG_POLL_MS);
          chat.waiters.add(done);
          req.on('close', () => { chat.waiters.delete(done); clearTimeout(timer); resolve(); });
        });
      }
      if (res.writableEnded || req.destroyed) return true;
      sendJson(res, 200, { messages: collect().map(publicMessage), typing: typingList(chat, user.id), wants: wantList(chat), version: chat.version, epoch: chat.epoch });
      return true;
    }

    if (req.method !== 'POST') return sendJson(res, 404, { error: 'Rota não encontrada' }), true;
    const data = await readJson(req).catch(() => ({}));
    const ctx = context(user, data.roomId, data.peerId);
    if (!ctx) return sendJson(res, 404, { error: 'Sala não encontrada' }), true;
    const { chat } = ctx;
    const author = { id: user.id, name: user.displayName, username: user.guest ? null : user.username || null, guest: !!user.guest, avatarUrl: user.avatarUrl || null, nameColor: user.nameColor || null };
    const find = (msgId) => chat.messages.find(m => m.id === msgId && !m.deleted);

    if (route === 'relay-want') {
      const hash = String(data.hash || '');
      if (!findP2PAttachment(chat, hash)) return sendJson(res, 404, { error: 'Arquivo desconhecido' }), true;
      if (chat.relay.has(hash)) return sendJson(res, 200, { ready: true }), true;
      const fresh = !chat.wants.has(hash);
      chat.wants.set(hash, Date.now());
      if (fresh) wake(chat);
      sendJson(res, 200, { ready: false });
      return true;
    }

    // History sent back by someone in the call after a server restart: signed messages only.
    if (route === 'restore') {
      const list = Array.isArray(data.messages) ? data.messages.slice(0, MAX_RESTORE) : [];
      const known = new Set(chat.messages.map(m => m.id));
      let added = 0;
      for (const m of list) {
        if (!m || typeof m.id !== 'string' || known.has(m.id) || m.deleted || !validSig(m)) continue;
        const { version, ...msg } = m;
        msg.version = 0;
        known.add(msg.id);
        chat.messages.push(msg);
        added++;
      }
      if (added) {
        chat.messages.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        while (chat.messages.length > MAX_MESSAGES) chat.messages.shift();
        for (const msg of chat.messages) if (!msg.version) touch(chat, msg);
      }
      sendJson(res, 200, { restored: added });
      return true;
    }

    if (route === 'send') {
      const content = cleanContent(data.content);
      if (content.length > MAX_CONTENT) return sendJson(res, 400, { error: `Mensagem acima de ${MAX_CONTENT} caracteres.` }), true;
      const attachments = [];
      for (const fileId of Array.isArray(data.attachments) ? data.attachments.slice(0, MAX_ATTACHMENTS) : []) {
        // P2P media: the server keeps only the description; the bytes travel between the people
        // in the room (identified and verified by their SHA-256).
        if (fileId && typeof fileId === 'object') {
          const a = fileId;
          const dim = (v) => (Number.isInteger(v) && v > 0 && v <= 20000 ? v : undefined);
          if (!/^[0-9a-f]{64}$/.test(String(a.hash)) || !/^image\/(png|jpeg|gif|webp)$/.test(String(a.type))) continue;
          if (!Number.isInteger(a.size) || a.size <= 0 || a.size > P2P_MAX_FILE_BYTES) continue;
          attachments.push({
            id: `p2p-${a.hash.slice(0, 16)}-${attachments.length}`, p2p: true, hash: a.hash,
            name: String(a.name || 'imagem').slice(0, 120), type: a.type, size: a.size,
            width: dim(a.width), height: dim(a.height), fromPeer: cleanPeerIdLocal(data.peerId)
          });
          continue;
        }
        const f = chat.files.get(String(fileId));
        if (!f || f.ownerId !== user.id || f.used) continue;
        f.used = true;
        attachments.push({ id: String(fileId), name: f.name, type: f.type, size: f.size, width: f.width, height: f.height });
      }
      if (!content && !attachments.length) return sendJson(res, 400, { error: 'Mensagem vazia.' }), true;
      if (limited(chat, user.id)) return sendJson(res, 429, { error: 'Calma! Você está enviando mensagens rápido demais.' }), true;
      const replyTarget = data.replyTo ? find(String(data.replyTo)) : null;
      const msg = {
        id: id(),
        nonce: typeof data.nonce === 'string' ? data.nonce.slice(0, 40) : undefined,
        author,
        content,
        attachments,
        embeds: [],
        reactions: [],
        replyTo: replyTarget ? {
          id: replyTarget.id,
          author: replyTarget.author,
          content: replyTarget.content.slice(0, 200),
          hasAttachments: !!replyTarget.attachments.length
        } : null,
        createdAt: Date.now(),
        editedAt: null,
        version: 0
      };
      chat.messages.push(msg);
      chat.typing.delete(user.id);
      // Keep the history bounded; attachments of messages that fall off are freed too.
      while (chat.messages.length > MAX_MESSAGES) {
        const old = chat.messages.shift();
        for (const a of old.attachments || []) dropFile(chat, a.id);
      }
      touch(chat, msg);
      addEmbeds(chat, msg);
      sendJson(res, 200, { message: msg });
      return true;
    }

    if (route === 'edit') {
      const msg = find(String(data.id));
      if (!msg || msg.author.id !== user.id) return sendJson(res, 403, { error: 'Você só pode editar suas mensagens.' }), true;
      const content = cleanContent(data.content);
      if (!content && !msg.attachments.length) return sendJson(res, 400, { error: 'Mensagem vazia.' }), true;
      if (content.length > MAX_CONTENT) return sendJson(res, 400, { error: `Mensagem acima de ${MAX_CONTENT} caracteres.` }), true;
      if (content !== msg.content) {
        msg.content = content;
        msg.editedAt = Date.now();
        msg.embeds = [];
        touch(chat, msg);
        addEmbeds(chat, msg);
      }
      sendJson(res, 200, { message: msg });
      return true;
    }

    if (route === 'delete') {
      const msg = find(String(data.id));
      if (!msg || msg.author.id !== user.id) return sendJson(res, 403, { error: 'Você só pode apagar suas mensagens.' }), true;
      for (const a of msg.attachments) dropFile(chat, a.id);
      // Tombstone: clients still learn about the deletion through events.
      Object.assign(msg, { deleted: true, content: '', attachments: [], embeds: [], reactions: [], replyTo: null });
      touch(chat, msg);
      sendJson(res, 200, { success: true });
      return true;
    }

    if (route === 'react') {
      const msg = find(String(data.id));
      const emoji = cleanEmoji(data.emoji);
      if (!msg || !emoji) return sendJson(res, 400, { error: 'Reação inválida.' }), true;
      let r = msg.reactions.find(x => x.emoji === emoji);
      const has = r?.users.some(u => u.id === user.id);
      const want = data.on === undefined ? !has : !!data.on;
      if (want && !has) {
        if (!r) {
          if (msg.reactions.length >= MAX_REACTIONS) return sendJson(res, 400, { error: 'Limite de reações nesta mensagem.' }), true;
          r = { emoji, users: [] };
          msg.reactions.push(r);
        }
        r.users.push({ id: user.id, name: user.displayName });
      } else if (!want && has) {
        r.users = r.users.filter(u => u.id !== user.id);
        if (!r.users.length) msg.reactions = msg.reactions.filter(x => x !== r);
      } else {
        return sendJson(res, 200, { success: true }), true;
      }
      touch(chat, msg);
      sendJson(res, 200, { success: true });
      return true;
    }

    if (route === 'typing') {
      if (data.stop) chat.typing.delete(user.id);
      else chat.typing.set(user.id, { name: user.displayName, until: Date.now() + TYPING_MS });
      wake(chat);
      sendJson(res, 200, { success: true });
      return true;
    }

    sendJson(res, 404, { error: 'Rota não encontrada' });
    return true;
  };
}

// Frees chat storage of rooms that are about to be deleted.
export function dropChat(room) {
  if (!room?.chat) return;
  for (const done of room.chat.waiters) done();
  room.chat = null;
}
