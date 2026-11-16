import { defineConfig, loadEnv } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { createChat, dropChat } from './server/chat.js';
import { createSfuManager } from './server/sfu-nodes.js';
import { randomBytes, createHmac, createHash, timingSafeEqual, scryptSync } from 'node:crypto';

// In-memory room signaling cache for Full Mesh Multi-Peer P2P
const rooms = new Map();

// Background tabs throttle timers to ~1/min, so a short timeout would kick
// peers whose P2P link is still perfectly healthy.
const PEER_TIMEOUT_MS = 60000;
const MAX_QUEUE = 500;
const MAX_BODY_BYTES = 256 * 1024;
// redial: "rebuild our connection now" from the side that can't (see webrtc.js recoverStuck). Old
// clients ignore it (no matching handler), so it is safe to send to anyone.
const SIGNAL_TYPES = new Set(['offer', 'answer', 'candidate', 'bye', 'redial']);
// Routes reported by the clients in the poll: P2P direct, TURN relay, or the media server (SFU).
const ROUTE_KINDS = { p: 'p2p', t: 'turn', s: 'sfu' };

const SESSION_COOKIE = 'kennyy_session';
const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;

// Helper to normalize room IDs (e.g. "et6hnjkkl" and "et6-hnj-kkl" resolve to the exact same room)
function normalizeRoomId(id) {
  if (!id) return '';
  const raw = String(id).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 32);
  if (/^[a-z0-9]{9}$/.test(raw)) {
    return `${raw.slice(0, 3)}-${raw.slice(3, 6)}-${raw.slice(6, 9)}`;
  }
  return raw;
}

// Optional room password: only a salted scrypt hash is kept, in memory, with the room.
const MAX_PASSWORD_LENGTH = 64;
const PASSWORD_MAX_FAILS = 5;
const PASSWORD_LOCK_MS = 60 * 1000;
// Optional cap on participants (0 = no limit).
const MAX_ROOM_LIMIT = 16;
const cleanMaxPeers = (value) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 2 && n <= MAX_ROOM_LIMIT ? n : 0;
};

function hashRoomPassword(password, salt = randomBytes(16)) {
  return { salt, hash: scryptSync(String(password), salt, 32) };
}

function checkRoomPassword(room, password) {
  if (!room.password) return true;
  if (typeof password !== 'string' || !password || password.length > MAX_PASSWORD_LENGTH) return false;
  const { hash } = hashRoomPassword(password, room.password.salt);
  return timingSafeEqual(hash, room.password.hash);
}

function cleanPeerId(id) {
  const value = String(id || '').trim();
  return /^p_[a-z0-9]{6,16}$/.test(value) ? value : '';
}

// Network type reported by the client (see probeNetwork in src/webrtc.js): "symmetric.1".
function cleanNet(value) {
  const m = /^(cone|symmetric|blocked|relay)\.([01])$/.exec(String(value || ''));
  return m ? { nat: m[1], v6: m[2] === '1' } : null;
}

// The address the request came from (nginx sets X-Real-IP), to tell people on the same network
// apart: they connect over the LAN whatever their NAT is. Never sent to other clients.
function clientIp(req) {
  return String(req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '').trim().slice(0, 64);
}

function cleanName(name, fallback) {
  const value = String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40);
  return value || fallback;
}

// Guest profile photos are never sent to the server: it only signs their SHA-256 and size
// ("p2p:<hash>:<size>") and the room downloads the bytes from the guest over WebRTC.
const GUEST_AVATAR_MAX_BYTES = 200 * 1024;
// Without a photo, one of public/avatars/1..8.jpg (the browser picks it so the preview matches).
const GUEST_DEFAULT_AVATARS = 8;

// "p2p:<sha256>:<size>" of a photo kept in the browser (guest login or Settings > Minha conta).
function cleanP2PAvatar(hash, size) {
  const h = String(hash || '');
  const n = Number(size);
  return /^[0-9a-f]{64}$/.test(h) && Number.isInteger(n) && n > 0 && n <= GUEST_AVATAR_MAX_BYTES ? `p2p:${h}:${n}` : null;
}

function cleanNameColor(value) {
  const hex = String(value || '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(hex) ? hex : null;
}

// Only allow same-site paths as post-login destinations (no "//evil.com").
function cleanReturnTo(value) {
  const path = String(value || '');
  return /^\/(?!\/)[^\s\\]*$/.test(path) && path.length < 200 ? path : '/';
}

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

function redirect(res, location, cookies = []) {
  res.statusCode = 302;
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function readText(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 8192) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// state: what the person reported in the poll (streaming, voice, watching), so everyone knows it
// even without a working connection to them. v2: understands "redial" and the room changing mode.
function roster(room) {
  return Array.from(room.peers.values(), p => ({ id: p.id, userId: p.userId, name: p.name, username: p.username || null, guest: !!p.guest, avatarUrl: p.avatarUrl, nameColor: p.nameColor || null, device: p.device, ...(p.state ? { state: p.state } : {}), ...(p.hybrid ? { v2: true } : {}) }));
}

// Reported by the client with the poll (?st=): its own state. Only known fields, bounded.
function cleanPeerState(raw) {
  if (!raw || raw.length > 2000) return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const ids = Array.isArray(data.w) ? data.w.filter(id => cleanPeerId(id)).slice(0, 32) : [];
  return {
    v: Number.isFinite(data.v) ? data.v : 0,
    s: !!data.s, // streaming
    a: !!data.a, // stream has audio
    m: data.m !== false, // mic muted
    d: !!data.d, // deafened
    c: !!data.c, // camera on
    w: ids // streamers this person watches
  };
}

function cleanupRooms() {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    for (const [peerId, peer] of room.peers.entries()) {
      if (now - peer.lastSeen > PEER_TIMEOUT_MS) {
        console.log(`[P2P-SIGNAL] Peer ${peer.name} (${peerId}) desconectado por timeout na sala ${roomId}`);
        room.peers.delete(peerId);
      }
    }
    if (room.peers.size === 0 && (now - room.lastActive > 5 * 60 * 1000)) {
      console.log(`[P2P-SIGNAL] Removendo sala vazia: ${roomId}`);
      dropChat(room);
      rooms.delete(roomId);
    }
  }
}

function getCookie(req, name) {
  const match = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function requestOrigin(req, publicUrl) {
  if (publicUrl) return publicUrl;
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  const host = req.headers.host || 'localhost:5173';
  return `${proto}://${host}`;
}

function isHttps(req, publicUrl) {
  return requestOrigin(req, publicUrl).startsWith('https://');
}

// Cookie session: base64url(JSON) + "." + HMAC-SHA256. The server never trusts
// names or avatars sent by the browser; they come from the signed Discord session.
function createSessions(secret) {
  const sign = (data) => createHmac('sha256', secret).update(data).digest('base64url');
  return {
    encode(user) {
      const payload = Buffer.from(JSON.stringify({ ...user, exp: Date.now() + SESSION_MAX_AGE_S * 1000 })).toString('base64url');
      return `${payload}.${sign(payload)}`;
    },
    read(req) {
      const raw = getCookie(req, SESSION_COOKIE);
      if (!raw) return null;
      const [payload, mac] = raw.split('.');
      if (!payload || !mac) return null;
      const expected = Buffer.from(sign(payload));
      const given = Buffer.from(mac);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
      try {
        const user = JSON.parse(Buffer.from(payload, 'base64url').toString());
        return user.exp > Date.now() ? user : null;
      } catch {
        return null;
      }
    }
  };
}

// Display name and profile colour chosen in Settings > Minha conta. The session holds them, and a
// second signed cookie keeps them for the next Discord login in this browser (it survives logout).
const PROFILE_COOKIE = 'kennyy_profile';
const PROFILE_MAX_AGE_S = 365 * 24 * 60 * 60;

function createProfiles(secret) {
  const sign = (data) => createHmac('sha256', `profile:${secret}`).update(data).digest('base64url');
  return {
    encode(profile) {
      const payload = Buffer.from(JSON.stringify(profile)).toString('base64url');
      return `${payload}.${sign(payload)}`;
    },
    read(req, userId) {
      const [payload, mac] = String(getCookie(req, PROFILE_COOKIE) || '').split('.');
      if (!payload || !mac) return null;
      const expected = Buffer.from(sign(payload));
      const given = Buffer.from(mac);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
      try {
        const profile = JSON.parse(Buffer.from(payload, 'base64url').toString());
        return profile.id === userId ? profile : null;
      } catch {
        return null;
      }
    },
    // A Discord login keeps the name and colour picked here (the Discord name stays as the fallback).
    apply(req, user) {
      const profile = this.read(req, user.id);
      if (!profile) return user;
      return {
        ...user,
        displayName: cleanName(profile.displayName, user.displayName),
        nameColor: cleanNameColor(profile.nameColor) || user.nameColor || null
      };
    }
  };
}

function cookie(name, value, { maxAge, secure, path = '/' }) {
  return `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function createSignalingMiddleware(env) {
  const clientId = env.DISCORD_CLIENT_ID;
  const clientSecret = env.DISCORD_CLIENT_SECRET;
  const publicUrl = (env.PUBLIC_URL || '').replace(/\/+$/, '');
  let sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret || sessionSecret.length < 32) {
    sessionSecret = randomBytes(32).toString('hex');
    console.warn('[AUTH] SESSION_SECRET ausente ou curto: usando um temporário. Todos terão que entrar de novo quando o servidor reiniciar.');
  }
  const sessions = createSessions(sessionSecret);
  const profiles = createProfiles(sessionSecret);
  // Desktop-app logins waiting to be redeemed: one-time code -> { user, challenge, returnTo, exp }
  const desktopCodes = new Map();
  const chat = createChat({ rooms, normalizeRoomId, cleanPeerId, sendJson, readJson, env, secret: sessionSecret });
  // Shared with turn-server/kscreen_turn.py (its TURN_SECRET); empty = no TURN offered.
  const turnSecret = env.TURN_SECRET || '';
  // Admin panel ("kstatus"): only these Discord ids get /api/admin/stats (none when ADMIN_IDS is empty).
  const adminIds = new Set(String(env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
  // TURN stats endpoint (kscreen_turn.py --stats-port), e.g. http://127.0.0.1:3479/stats
  const turnStatsUrl = env.TURN_STATS_URL || '';
  let turnClockOffset = 0; // ms the TURN's clock is ahead of ours (learned from its 401)
  const serverStarted = Date.now();
  // Media servers (LiveKit SFU nodes), managed in the admin panel, and the hybrid room mode:
  // P2P up to a few people, SFU above that or when someone can't connect. See server/sfu-nodes.js.
  const sfu = createSfuManager({ rooms, env, sendJson, readJson });
  const cleanNodeId = (id) => (/^n_[a-z0-9]{4,16}$/.test(String(id || '')) ? String(id) : null);
  // A room's starting mode. After a server restart members re-join with the mode they use.
  const roomMode = (data) => {
    const wanted = data?.mode === 'sfu' || data?.mode === 'mesh' ? data.mode : null;
    return sfu.modeOnCreate(data?.sfu === true, wanted);
  };

  return async (req, res, next) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return next();

    try {
      // --- GUEST LOGIN (name required; photo and name color optional) ---
      if (req.method === 'POST' && url.pathname === '/api/auth/guest') {
        const data = await readJson(req).catch(() => null);
        const name = cleanName(data?.name, '');
        if (!data || name.length < 2) {
          sendJson(res, 400, { error: 'Escolha um nome (mínimo 2 caracteres).' });
          return;
        }
        const id = `g_${randomBytes(9).toString('hex')}`;
        const pick = Number(data.defaultAvatar);
        let avatarUrl = `/avatars/${Number.isInteger(pick) && pick >= 1 && pick <= GUEST_DEFAULT_AVATARS ? pick : 1 + Math.floor(Math.random() * GUEST_DEFAULT_AVATARS)}.jpg`;
        avatarUrl = cleanP2PAvatar(data.avatarHash, data.avatarSize) || avatarUrl;
        const sessionUser = { id, username: null, displayName: name, avatarUrl, nameColor: cleanNameColor(data.nameColor), guest: true };
        console.log(`[GUEST-AUTH] Convidado "${name}" (${id})`);
        res.setHeader('Set-Cookie', cookie(SESSION_COOKIE, sessions.encode(sessionUser), { maxAge: SESSION_MAX_AGE_S, secure: isHttps(req, publicUrl) }));
        sendJson(res, 200, { user: sessionUser });
        return;
      }

      // --- DISCORD OAUTH2 ROUTES ---
      if (req.method === 'GET' && url.pathname === '/api/auth/discord/login') {
        if (!clientId || !clientSecret) {
          redirect(res, '/?error=discord_not_configured');
          return;
        }
        const secure = isHttps(req, publicUrl);
        const state = randomBytes(16).toString('hex');
        const redirectUri = `${requestOrigin(req, publicUrl)}/api/auth/discord/callback`;
        const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=identify&state=${state}`;
        const cookies = [
          cookie('kennyy_oauth_state', state, { maxAge: 600, secure, path: '/api/auth' }),
          cookie('kennyy_return_to', cleanReturnTo(url.searchParams.get('returnTo')), { maxAge: 600, secure, path: '/api/auth' })
        ];
        // Desktop app (RFC 8252): the login runs in the system browser and the result goes back to
        // the app on 127.0.0.1:<port>, as a one-time code that only the app's verifier can redeem.
        const desktopPort = Number(url.searchParams.get('desktop'));
        const challenge = url.searchParams.get('challenge') || '';
        if (Number.isInteger(desktopPort) && desktopPort >= 1024 && desktopPort <= 65535 && /^[A-Za-z0-9_-]{43}$/.test(challenge)) {
          cookies.push(cookie('kennyy_desktop', `${desktopPort}.${challenge}`, { maxAge: 600, secure, path: '/api/auth' }));
        } else {
          cookies.push(cookie('kennyy_desktop', '', { maxAge: 0, secure, path: '/api/auth' }));
        }
        redirect(res, discordAuthUrl, cookies);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/auth/desktop/redeem') {
        const form = new URLSearchParams(await readText(req));
        const entry = desktopCodes.get(form.get('code') || '');
        desktopCodes.delete(form.get('code') || '');
        const verifier = form.get('verifier') || '';
        const proof = createHash('sha256').update(verifier).digest('base64url');
        if (!entry || entry.exp < Date.now() || !safeEqual(proof, entry.challenge)) {
          redirect(res, '/?error=desktop_auth');
          return;
        }
        // The app has its own cookies: its saved profile wins over the system browser's.
        redirect(res, entry.returnTo, [
          cookie(SESSION_COOKIE, sessions.encode(profiles.apply(req, entry.user)), { maxAge: SESSION_MAX_AGE_S, secure: isHttps(req, publicUrl) })
        ]);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/auth/discord/callback') {
        const secure = isHttps(req, publicUrl);
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const expectedState = getCookie(req, 'kennyy_oauth_state');
        const returnTo = cleanReturnTo(getCookie(req, 'kennyy_return_to'));
        const clearOauth = [
          cookie('kennyy_oauth_state', '', { maxAge: 0, secure, path: '/api/auth' }),
          cookie('kennyy_return_to', '', { maxAge: 0, secure, path: '/api/auth' })
        ];
        if (!code || !state || state !== expectedState) {
          const desktopPort = /^(\d{4,5})\./.exec(getCookie(req, 'kennyy_desktop') || '')?.[1];
          const reason = code ? 'auth_state' : 'no_code';
          redirect(res, desktopPort ? `http://127.0.0.1:${desktopPort}/kscreen-auth?error=${reason}` : `/?error=${reason}`, [
            ...clearOauth,
            cookie('kennyy_desktop', '', { maxAge: 0, secure, path: '/api/auth' })
          ]);
          return;
        }

        const redirectUri = `${requestOrigin(req, publicUrl)}/api/auth/discord/callback`;
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri
          })
        });

        if (!tokenRes.ok) {
          console.error('[DISCORD-AUTH] Token exchange failed:', await tokenRes.text());
          redirect(res, '/?error=auth_redirect', clearOauth);
          return;
        }

        const tokenData = await tokenRes.json();
        const userRes = await fetch('https://discord.com/api/users/@me', {
          headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        if (!userRes.ok) throw new Error(`Discord /users/@me ${userRes.status}`);

        const userData = await userRes.json();
        const avatarUrl = userData.avatar
          ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png?size=128`
          : `https://cdn.discordapp.com/embed/avatars/${(BigInt(userData.id || 0) >> 22n) % 6n}.png`;

        const discordName = cleanName(userData.global_name || userData.username, 'Usuário');
        const sessionUser = profiles.apply(req, {
          id: String(userData.id),
          username: cleanName(userData.username, 'Usuário'),
          displayName: discordName,
          discordName,
          avatarUrl
        });
        console.log(`[DISCORD-AUTH] Login de ${sessionUser.username} (${sessionUser.id})`);

        const desktop = /^(\d{4,5})\.([A-Za-z0-9_-]{43})$/.exec(getCookie(req, 'kennyy_desktop') || '');
        if (desktop) {
          // Hand the login to the desktop app instead of this browser.
          const now = Date.now();
          for (const [key, value] of desktopCodes) if (value.exp < now) desktopCodes.delete(key);
          if (desktopCodes.size > 1000) desktopCodes.clear();
          const oneTime = randomBytes(32).toString('base64url');
          desktopCodes.set(oneTime, { user: sessionUser, challenge: desktop[2], returnTo, exp: now + 2 * 60 * 1000 });
          redirect(res, `http://127.0.0.1:${desktop[1]}/kscreen-auth?code=${oneTime}`, [
            ...clearOauth,
            cookie('kennyy_desktop', '', { maxAge: 0, secure, path: '/api/auth' })
          ]);
          return;
        }

        redirect(res, returnTo, [
          ...clearOauth,
          cookie(SESSION_COOKIE, sessions.encode(sessionUser), { maxAge: SESSION_MAX_AGE_S, secure })
        ]);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/auth/me') {
        const user = sessions.read(req);
        if (!user) {
          sendJson(res, 401, { error: 'Não autenticado' });
          return;
        }
        const { exp, ...publicUser } = user;
        if (user.guest) publicUser.username = null;
        sendJson(res, 200, { user: { ...publicUser, admin: adminIds.has(String(user.id)) } });
        return;
      }

      // Settings > Minha conta: display name and profile colour, for every kind of account.
      // An empty name on a Discord account goes back to the Discord name.
      if (req.method === 'POST' && url.pathname === '/api/auth/profile') {
        const user = sessions.read(req);
        if (!user) {
          sendJson(res, 401, { error: 'Não autenticado' });
          return;
        }
        const data = await readJson(req).catch(() => null);
        if (!data) {
          sendJson(res, 400, { error: 'Dados inválidos.' });
          return;
        }
        const next = { ...user };
        delete next.exp;
        if (user.guest) next.username = null;
        if ('displayName' in data) {
          const name = cleanName(String(data.displayName || '').replace(/\s+/g, ' '), '');
          if (name.length < 2 && (user.guest || name)) {
            sendJson(res, 400, { error: 'O nome precisa ter pelo menos 2 caracteres.' });
            return;
          }
          next.displayName = name || user.discordName || user.username || user.displayName;
        }
        if ('nameColor' in data) next.nameColor = cleanNameColor(data.nameColor);
        // Guests' photo: "p2p:" like the guest login (the bytes never come here). Discord
        // accounts keep the Discord photo.
        if ('avatarHash' in data) {
          const photo = user.guest ? cleanP2PAvatar(data.avatarHash, data.avatarSize) : null;
          if (!photo) {
            sendJson(res, 400, { error: user.guest ? 'Foto inválida. Tente outra imagem.' : 'A foto vem do seu Discord.' });
            return;
          }
          next.avatarUrl = photo;
        }
        // People already in a call see the change on their next poll.
        for (const room of rooms.values()) {
          for (const peer of room.peers.values()) {
            if (peer.userId !== user.id) continue;
            peer.name = next.displayName;
            peer.nameColor = next.nameColor || null;
            peer.avatarUrl = next.avatarUrl;
          }
        }
        const secure = isHttps(req, publicUrl);
        res.setHeader('Set-Cookie', [
          cookie(SESSION_COOKIE, sessions.encode(next), { maxAge: SESSION_MAX_AGE_S, secure }),
          cookie(PROFILE_COOKIE, profiles.encode({ id: user.id, displayName: next.displayName, nameColor: next.nameColor || null }), { maxAge: PROFILE_MAX_AGE_S, secure })
        ]);
        sendJson(res, 200, { user: { ...next, admin: adminIds.has(String(user.id)) } });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
        res.setHeader('Set-Cookie', cookie(SESSION_COOKIE, '', { maxAge: 0, secure: isHttps(req, publicUrl) }));
        sendJson(res, 200, { success: true });
        return;
      }

      // --- ROOM MANAGEMENT ROUTES (Discord login required) ---
      const user = sessions.read(req);
      if (!user) {
        sendJson(res, 401, { error: 'Entre com o Discord para continuar.' });
        return;
      }
      // A peer id can only be used by the Discord account that registered it.
      const ownPeer = (room, peerId) => {
        const peer = room?.peers.get(peerId);
        return peer && peer.userId === user.id ? peer : null;
      };

      // Room text chat (server/chat.js)
      if (await chat(req, res, url, user)) return;

      // Admin panel: media server nodes (add, edit, test, migrate, traffic).
      if (url.pathname.startsWith('/api/admin/sfu')) {
        if (!adminIds.has(String(user.id))) {
          sendJson(res, 404, { error: 'Não encontrado' });
          return;
        }
        await sfu.admin(req, res, url);
        return;
      }

      // Admin panel: rooms with people, TURN usage. Checked here, on the server.
      if (req.method === 'GET' && url.pathname === '/api/admin/stats') {
        if (!adminIds.has(String(user.id))) {
          sendJson(res, 404, { error: 'Não encontrado' });
          return;
        }
        cleanupRooms();
        const now = Date.now();
        // Route of each person, from what the browsers report: TURN when any of their
        // connections goes through the relay (either side saying so is enough), P2P when all are
        // direct, null while alone or still connecting.
        const routeOf = (room, peer) => {
          let route = null;
          for (const other of room.peers.values()) {
            if (other === peer) continue;
            const kinds = [peer.routes?.get(other.id), other.routes?.get(peer.id)];
            if (kinds.includes('turn')) return 'turn';
            if (kinds.includes('sfu')) route = 'sfu';
            else if (kinds.includes('p2p') && route !== 'sfu') route = 'p2p';
          }
          return route;
        };
        const list = [...rooms.values()]
          .filter(room => room.peers.size > 0)
          .map(room => {
            const members = [...room.peers.values()].map(p => ({ id: String(p.userId), name: p.name, route: routeOf(room, p) }));
            return {
              id: room.id,
              people: room.peers.size,
              names: members.map(m => m.name),
              members,
              p2p: members.filter(m => m.route === 'p2p').length,
              turn: members.filter(m => m.route === 'turn').length,
              sfu: members.filter(m => m.route === 'sfu').length,
              mode: room.mode || 'mesh',
              modeReason: room.modeReason || '',
              node: room.mode === 'sfu' ? sfu.nodeName(room.sfuNode) : null,
              locked: !!room.password,
              maxPeers: room.maxPeers,
              minutes: Math.round((now - room.created) / 60000)
            };
          })
          .sort((a, b) => b.people - a.people);
        let turn = null;
        if (!turnStatsUrl || !turnSecret) {
          turn = { error: 'não configurado (TURN_STATS_URL)' };
        } else {
          try {
            // Changes every minute (see kscreen_turn.py stats_token): useless if intercepted.
            // It's computed on the TURN's clock (learned from its 401), so VPS clocks that
            // drifted apart don't lock the panel out.
            const ask = (offsetMs) => {
              const minute = Math.floor((Date.now() + offsetMs) / 60000);
              const token = createHmac('sha256', turnSecret).update(`kscreen-turn-stats:${minute}`).digest('hex');
              return fetch(turnStatsUrl, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });
            };
            let r = await ask(turnClockOffset);
            if (r.status === 401) {
              const info = await r.json().catch(() => ({}));
              const ourKey = createHmac('sha256', turnSecret).update('kscreen-turn-fingerprint').digest('hex').slice(0, 12);
              if (!info.key) {
                // Only the old kscreen_turn.py answers 401 without its clock/fingerprint. The
                // service runs the copy in /opt/kscreen-turn, which only install.sh updates.
                turn = { error: 'respondeu 401: o TURN ainda roda a versão antiga (rode sudo ./install.sh de novo na pasta turn-server)' };
              } else if (info.key !== ourKey) {
                turn = { error: 'TURN_SECRET diferente entre o site e o TURN' };
              } else {
                turnClockOffset = info.time * 1000 - Date.now();
                r = await ask(turnClockOffset);
              }
            }
            if (!turn) {
              turn = r.ok ? await r.json() : { error: `respondeu ${r.status}` };
              // Shown in the panel: a drifting clock also breaks TURN logins near expiry.
              if (r.ok && Math.abs(turnClockOffset) > 30000) {
                turn.clock_skew_s = Math.round(turnClockOffset / 1000);
              }
            }
          } catch (err) {
            turn = { error: 'fora do ar' };
          }
        }
        // TURN only knows Discord ids: keep the id so the panel can match its traffic to people.
        if (turn?.per_user) {
          turn.per_user = Object.entries(turn.per_user).map(([id, u]) => ({ id, ...u }));
        }
        sendJson(res, 200, {
          rooms: {
            active: list.length,
            total: rooms.size,
            people: list.reduce((n, r) => n + r.people, 0),
            p2p: list.reduce((n, r) => n + r.p2p, 0),
            turn: list.reduce((n, r) => n + r.turn, 0),
            sfu: list.reduce((n, r) => n + (r.sfu || 0), 0),
            list
          },
          turn,
          server: { uptimeS: Math.round((now - serverStarted) / 1000), memoryMb: Math.round(process.memoryUsage().rss / 1e6) }
        });
        return;
      }

      // 0. TURN credentials. LEGACY: current pages don't use TURN (a pair without direct P2P moves the
      // room to the SFU). Kept only for pages opened before that change. "TURN REST API" style:
      // username "<expiry>:<user>", password = base64(HMAC-SHA1(TURN_SECRET, username)).
      // Valid 24 h so long calls keep refreshing their relay allocation.
      if (req.method === 'GET' && url.pathname === '/api/turn') {
        const urls = String(env.TURN_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
        if (!urls.length || !turnSecret) {
          sendJson(res, 200, { iceServers: [], ttl: 0 });
          return;
        }
        const ttl = 24 * 60 * 60;
        const username = `${Math.floor(Date.now() / 1000) + ttl}:${user.id}`;
        const credential = createHmac('sha1', turnSecret).update(username).digest('base64');
        sendJson(res, 200, { iceServers: [{ urls, username, credential }], ttl });
        return;
      }

      // 0b. Media server (SFU) token: only for a peer of this account that is in an SFU room.
      if (req.method === 'POST' && url.pathname === '/api/sfu/token') {
        const data = await readJson(req).catch(() => ({}));
        const room = rooms.get(normalizeRoomId(data.roomId));
        const peer = ownPeer(room, cleanPeerId(data.peerId));
        if (!peer || room.mode !== 'sfu') {
          sendJson(res, 404, { error: 'Sala ou participante não encontrado' });
          return;
        }
        const grant = sfu.tokenFor(room, peer, user.id);
        if (!grant) {
          sendJson(res, 503, { error: 'Nenhum servidor de mídia disponível agora.' });
          return;
        }
        sendJson(res, 200, grant);
        return;
      }

      // 1. Create Room (Google Meet-style room code xxx-xxx-xxx)
      if (req.method === 'POST' && url.pathname === '/api/room/create') {
        const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
        const part = (len) => Array.from(randomBytes(len), b => chars[b % chars.length]).join('');
        const data = await readJson(req).catch(() => ({}));
        const password = typeof data.password === 'string' ? data.password : '';
        if (password.length > MAX_PASSWORD_LENGTH) {
          sendJson(res, 400, { error: `A senha pode ter no máximo ${MAX_PASSWORD_LENGTH} caracteres.` });
          return;
        }
        let roomId;
        do {
          roomId = `${part(3)}-${part(3)}-${part(3)}`;
        } while (rooms.has(roomId));

        rooms.set(roomId, {
          id: roomId,
          created: Date.now(),
          lastActive: Date.now(),
          peers: new Map(),
          password: password ? hashRoomPassword(password) : null,
          maxPeers: cleanMaxPeers(data.maxPeers),
          mode: roomMode(data),
          // Asking for "sfu" when creating = a test or tool that wants this room in the SFU for good.
          ...(data.mode === 'sfu' && roomMode(data) === 'sfu' ? { modeLock: 'sfu' } : {}),
          fails: new Map() // userId -> { count, until }
        });
        console.log(`[P2P-SIGNAL] Sala criada: ${roomId} por ${user.username}${password ? ' (com senha)' : ''}`);
        sendJson(res, 200, { roomId, locked: !!password, maxPeers: rooms.get(roomId).maxPeers, mode: rooms.get(roomId).mode });
        return;
      }

      // 2. Join Room (registers peer, returns active peers)
      if (req.method === 'POST' && url.pathname === '/api/room/join') {
        const data = await readJson(req);
        const roomId = normalizeRoomId(data.roomId);
        const peerId = cleanPeerId(data.peerId);
        if (!roomId || !peerId) {
          sendJson(res, 400, { error: 'Dados inválidos. roomId e peerId são obrigatórios.' });
          return;
        }

        let room = rooms.get(roomId);
        if (!room) {
          // Entering a code directly works even if nobody created it first. After a server restart
          // the members re-join with the room's password and people limit, which keeps both.
          const password = typeof data.password === 'string' && data.password.length <= MAX_PASSWORD_LENGTH ? data.password : '';
          room = {
            id: roomId,
            created: Date.now(),
            lastActive: Date.now(),
            peers: new Map(),
            password: password ? hashRoomPassword(password) : null,
            maxPeers: cleanMaxPeers(data.maxPeers),
            mode: roomMode(data),
            // Recreated by a re-join (server restart): the reason it was in the SFU is gone, so it
            // is checked again like a room that had no P2P (see evaluate in server/sfu-nodes.js).
            modeCause: 'restored',
            // After a server restart the room goes back to the node its people are on.
            sfuNode: cleanNodeId(data.sfuNode),
            fails: new Map()
          };
          rooms.set(roomId, room);
        }
        room.mode ||= 'mesh';
        // An SFU room only works for clients that speak SFU: an old cached page would sit alone
        // in a mesh nobody else uses.
        if (room.mode === 'sfu' && data.sfu !== true) {
          sendJson(res, 426, { error: 'O kScreen foi atualizado. Recarregue a página (Ctrl+Shift+R) para entrar nesta sala.', code: 'UPDATE_REQUIRED' });
          return;
        }

        if (room.password) {
          const fail = room.fails.get(user.id);
          if (fail && fail.until > Date.now()) {
            sendJson(res, 429, { error: 'Muitas tentativas. Tente de novo em um minuto.', code: 'TOO_MANY' });
            return;
          }
          if (!data.password) {
            sendJson(res, 403, { error: 'Esta sala tem senha.', code: 'PASSWORD_REQUIRED' });
            return;
          }
          if (!checkRoomPassword(room, data.password)) {
            const count = (fail?.count || 0) + 1;
            room.fails.set(user.id, count >= PASSWORD_MAX_FAILS ? { count: 0, until: Date.now() + PASSWORD_LOCK_MS } : { count, until: 0 });
            sendJson(res, 403, { error: 'Senha incorreta.', code: 'PASSWORD_WRONG' });
            return;
          }
          room.fails.delete(user.id);
        }

        // Full room: the same person re-joining (reconnect, reload) still gets in.
        if (room.maxPeers && !room.peers.has(peerId)) {
          const others = [...room.peers.values()].filter(p => p.userId !== user.id).length;
          if (others >= room.maxPeers) {
            sendJson(res, 403, { error: `A sala está cheia (${room.maxPeers} pessoas).`, code: 'ROOM_FULL' });
            return;
          }
        }

        const existing = room.peers.get(peerId);
        if (existing && existing.userId !== user.id) {
          sendJson(res, 409, { error: 'Identificador de participante em uso.' });
          return;
        }
        // One instance per device kind and account (desktop app, browser, phone): joining again
        // from the same kind replaces the older instance, which is told so on its next poll.
        const device = ['desktop', 'browser', 'mobile'].includes(data.device) ? data.device : 'browser';
        room.replaced ||= new Map();
        room.replaced.delete(peerId);
        for (const other of [...room.peers.values()]) {
          if (other.id !== peerId && other.userId === user.id && other.device === device) {
            room.peers.delete(other.id);
            room.replaced.set(other.id, { at: Date.now(), device });
            console.log(`[P2P-SIGNAL] "${other.name}" (${device}) substituído por uma nova instância na sala ${roomId}`);
          }
        }
        for (const [id, r] of room.replaced) if (Date.now() - r.at > 10 * 60 * 1000) room.replaced.delete(id);
        const peer = {
          id: peerId,
          userId: user.id,
          device,
          name: user.displayName,
          username: user.guest ? null : user.username || null,
          guest: !!user.guest,
          avatarUrl: user.avatarUrl,
          nameColor: user.nameColor || null,
          lastSeen: Date.now(),
          // Can follow the room into the SFU (any page since the SFU), and can switch modes
          // without re-joining (hybrid). Older SFU pages switch by re-joining (see the poll).
          sfuCapable: data.sfu === true,
          hybrid: data.hybrid === true,
          state: existing?.state || null,
          fails: existing?.fails || new Set(),
          // Server-only (not in the roster): predicts pairs that can't do direct P2P.
          net: cleanNet(data.net) || existing?.net || null,
          ip: clientIp(req),
          // A re-join after a server hiccup keeps signals that were already queued.
          queue: existing ? existing.queue : []
        };
        room.peers.set(peerId, peer);
        room.lastActive = Date.now();
        // The newcomer may push the room past the P2P limit: decide before answering.
        sfu.evaluate(room);
        peer.modeSeen = room.mode;
        console.log(`[P2P-SIGNAL] "${peer.name}" entrou na sala ${roomId} (${room.peers.size} na sala)`);

        sendJson(res, 200, {
          roomId,
          peerId,
          locked: !!room.password,
          maxPeers: room.maxPeers || 0,
          mode: room.mode,
          ...(room.mode === 'sfu' ? { sfu: sfu.roomKey(room) } : {}),
          peerName: peer.name,
          existingPeers: roster(room).filter(p => p.id !== peerId)
        });
        return;
      }

      // 3. Targeted signal (offer, answer, candidate or bye)
      if (req.method === 'POST' && url.pathname === '/api/room/signal') {
        const data = await readJson(req);
        const fromPeerId = cleanPeerId(data.fromPeerId);
        const toPeerId = cleanPeerId(data.toPeerId);
        if (!data.roomId || !fromPeerId || !toPeerId || !SIGNAL_TYPES.has(data.type)) {
          sendJson(res, 400, { error: 'Sinal inválido' });
          return;
        }

        const room = rooms.get(normalizeRoomId(data.roomId));
        const fromPeer = ownPeer(room, fromPeerId);
        if (!fromPeer) {
          sendJson(res, 404, { error: 'Sala ou participante não encontrado' });
          return;
        }
        const targetPeer = room.peers.get(toPeerId);
        if (!targetPeer) {
          sendJson(res, 200, { success: false, reason: 'Peer de destino não encontrado' });
          return;
        }

        const payload = data.payload ?? null;
        const queue = targetPeer.queue;
        // A new main-connection offer replaces the old connection: whatever is still queued for
        // the old one is useless (a background tab can pile up hundreds of candidates).
        if (data.type === 'offer' && payload?.connId && !payload.lane) {
          targetPeer.queue = queue.filter(m => m.fromPeerId !== fromPeerId || m.payload?.connId === payload.connId);
        }
        if (targetPeer.queue.length >= MAX_QUEUE) {
          // Full: drop the oldest candidate, never an offer or answer (the connection dies without them).
          const i = targetPeer.queue.findIndex(m => m.type === 'candidate');
          targetPeer.queue.splice(i >= 0 ? i : 0, 1);
        }
        targetPeer.queue.push({ fromPeerId, type: data.type, payload });
        fromPeer.lastSeen = Date.now();
        sendJson(res, 200, { success: true });
        return;
      }

      // 4. Poll signals & roster (also acts as heartbeat)
      if (req.method === 'GET' && url.pathname === '/api/room/poll') {
        const room = rooms.get(normalizeRoomId(url.searchParams.get('roomId')));
        const peer = ownPeer(room, cleanPeerId(url.searchParams.get('peerId')));
        const replaced = !peer && room?.replaced?.get(cleanPeerId(url.searchParams.get('peerId')));
        if (replaced) {
          room.replaced.delete(cleanPeerId(url.searchParams.get('peerId')));
          sendJson(res, 409, { error: 'Você entrou nesta sala em outra instância deste dispositivo.', code: 'REPLACED', device: replaced.device });
          return;
        }
        if (!peer) {
          // The client re-joins on 404 (server restart or timeout).
          sendJson(res, 404, { error: 'Participante não registrado nesta sala' });
          return;
        }

        peer.lastSeen = Date.now();
        room.lastActive = Date.now();
        // The room changed mode (hybrid) since this page joined. A page that can't switch on its
        // own is sent to re-join (404), which hands it the new mode.
        if (peer.modeSeen !== room.mode && !peer.hybrid) {
          peer.modeSeen = room.mode;
          sendJson(res, 404, { error: 'A sala mudou de modo', code: 'MODE_CHANGED' });
          return;
        }
        peer.modeSeen = room.mode;
        const state = cleanPeerState(url.searchParams.get('st'));
        if (state) peer.state = state;
        const net = cleanNet(url.searchParams.get('net'));
        if (net) {
          peer.net = net;
          peer.ip = clientIp(req);
          sfu.evaluate(room);
        }
        // People this peer can't connect to at all: moves the room to the SFU (when there is one).
        if (url.searchParams.has('fail')) {
          const ids = String(url.searchParams.get('fail') || '').split(',').map(cleanPeerId).filter(Boolean).slice(0, 16);
          const before = [...peer.fails].join(',');
          peer.fails = new Set(ids);
          if (ids.join(',') !== before && ids.length) {
            console.log(`[P2P-SIGNAL] "${peer.name}" sem conexão com ${ids.map(id => room.peers.get(id)?.name || id).join(', ')} na sala ${room.id}`);
            sfu.evaluate(room);
          }
        }
        // kbps sent/received through the media server ("up.down"), summed per node.
        const traffic = /^(\d{1,7})\.(\d{1,7})$/.exec(url.searchParams.get('sfu') || '');
        if (traffic && room.mode === 'sfu') sfu.reportTraffic(peer, traffic[1], traffic[2]);
        // Which route each of this peer's connections really uses (admin panel: P2P or TURN).
        peer.routes = new Map();
        for (const part of String(url.searchParams.get('routes') || '').split(',').slice(0, 64)) {
          const [otherId, kind] = part.split('.');
          if (cleanPeerId(otherId) && ROUTE_KINDS[kind]) peer.routes.set(otherId, ROUTE_KINDS[kind]);
        }
        const signals = peer.queue;
        peer.queue = [];
        sendJson(res, 200, { signals, peers: roster(room), mode: room.mode, ...(room.mode === 'sfu' ? { sfu: sfu.roomKey(room) } : {}) });
        return;
      }

      // 5. Leave room (also called via navigator.sendBeacon on page close)
      if (req.method === 'POST' && url.pathname === '/api/room/leave') {
        const data = await readJson(req).catch(() => ({}));
        const room = rooms.get(normalizeRoomId(data.roomId));
        const peerId = cleanPeerId(data.peerId);
        if (ownPeer(room, peerId)) {
          console.log(`[P2P-SIGNAL] "${room.peers.get(peerId).name}" saiu da sala ${room.id}`);
          room.peers.delete(peerId);
          // The last person left on purpose: the room and its chat go now ("quando todos saírem,
          // o chat é apagado"). A reload/closed tab (no `final`) keeps the 5-minute grace.
          if (data.final === true && room.peers.size === 0) {
            console.log(`[P2P-SIGNAL] Sala ${room.id} vazia: removida com o chat`);
            dropChat(room);
            rooms.delete(room.id);
          }
        }
        sendJson(res, 200, { success: true });
        return;
      }

      sendJson(res, 404, { error: 'Rota não encontrada' });
    } catch (err) {
      console.error('[P2P-SIGNAL] Erro na requisição:', err);
      if (!res.headersSent) sendJson(res, 400, { error: 'Requisição inválida' });
    }
  };
}

function p2pSignalingPlugin(env) {
  let cleanupTimer = null;
  let middleware = null;
  const install = (server) => {
    if (!cleanupTimer) {
      cleanupTimer = setInterval(cleanupRooms, 5000);
      cleanupTimer.unref?.();
    }
    middleware ??= createSignalingMiddleware(env);
    server.middlewares.use(middleware);
  };
  return {
    name: 'p2p-signaling-plugin',
    configureServer: install,
    // `vite preview` serves the production build with the same signaling API.
    configurePreviewServer: install
  };
}

export default defineConfig(({ mode }) => {
  // Secrets (DISCORD_CLIENT_SECRET, SESSION_SECRET) come from .env.local (never commit it).
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  // KSS_HTTPS=0 serves plain HTTP: fine on localhost (a secure context) or behind an HTTPS proxy.
  const https = env.KSS_HTTPS !== '0';
  // Vite rejects unknown Host headers; behind nginx the public domain must be allowed.
  let publicHost = null;
  try {
    publicHost = env.PUBLIC_URL ? new URL(env.PUBLIC_URL).hostname : null;
  } catch {
    console.warn(`[CONFIG] PUBLIC_URL inválido: ${env.PUBLIC_URL}`);
  }
  const allowedHosts = ['screen.kennyy.com.br', '.kennyy.com.br'];

  return {
    plugins: [...(https ? [basicSsl()] : []), p2pSignalingPlugin(env)],
    server: {
      host: true,
      port: 5173,
      allowedHosts
    },
    preview: {
      host: true,
      port: 4173,
      allowedHosts
    }
  };
});
