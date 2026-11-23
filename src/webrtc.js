/**
 * Kennyy ScreenShare - Full Mesh Multi-Peer WebRTC P2P Engine
 *
 * - Perfect negotiation (W3C pattern): glare between two peers resolves deterministically.
 * - Fixed sendrecv transceivers (video, screen audio, mic): starting/stopping a share
 *   is a replaceTrack(), never a renegotiation.
 * - Self-healing: ICE restart on failure, full reconnect after repeated failures,
 *   automatic re-join when the signaling server forgets us.
 */

// Noise suppression (RNNoise in an AudioWorklet): both files are only downloaded when it's on.
import noiseWorkletUrl from './noise-worklet.js?url';
import rnnoiseWasmUrl from './vendor/rnnoise/rnnoise-0.2.wasm?url';

let rnnoiseBytes = null;
function loadRnnoise() {
  rnnoiseBytes ??= fetch(rnnoiseWasmUrl).then((r) => {
    if (!r.ok) throw new Error(`rnnoise ${r.status}`);
    return r.arrayBuffer();
  }).catch((err) => {
    rnnoiseBytes = null; // try again next time
    throw err;
  });
  return rnnoiseBytes;
}

// Few servers on purpose: every extra STUN server slows candidate gathering.
// The IPv4 literal helps IPv6-only mobile networks (CLAT/NAT64) find a public IPv4 candidate.
// No TURN (legacy since 15/11/2026): a pair that can't connect directly moves the room to the
// media server (SFU) instead of relaying through a TURN server. See linkFailed.
export const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:74.125.250.129:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' }
];

// "disconnected" often heals by itself (a lost consent check, a Wi-Fi hiccup): restarting ICE
// too early only adds load.
const DISCONNECT_GRACE_MS = 8000;
// After an ICE restart: if the connection did not come back by then, try the next step.
// Without this a restart that never produced a state change left the peer stuck forever.
const RESTART_WATCHDOG_MS = 15000;
// Direct routes connect in a few seconds (1–3 s is typical); past this the attempt failed. Most
// impossible pairs never get here: probeNetwork predicts them and the room starts in the SFU.
const CONNECT_TIMEOUT_MS = 10000;
// The answering side has no say in rebuilding: past this it asks the dialing side to (redial).
const RESPONDER_TIMEOUT_MS = CONNECT_TIMEOUT_MS + 5000;
// A pair whose first direct try fails is "sem conexão" right away: reported to the server (which
// moves the room to the media server when it has one) and retried slowly in the background.
const UNREACHABLE_AFTER = 1;
// How long a join waits for the network probe (it starts when the page loads).
const NET_PROBE_WAIT_MS = 2500;
// The network is probed again after this long, or when it changes (Wi-Fi <-> 4G/5G).
const NET_PROBE_MAX_AGE_MS = 5 * 60 * 1000;
const UNREACHABLE_RETRY_MS = 60000;
// Our own state goes with the poll when it changes, and again now and then (server restarts).
const STATE_REFRESH_MS = 30000;
// Hidden setting "Forçar conexão via relay" (see forceRelay).
export const FORCE_RELAY_KEY = 'kscreen.forceRelay';

// What kind of network this device is on, for P2P: asks every STUN server in ICE_SERVERS for our
// public address, from the same local socket.
//  - "cone": every server saw the same public port (Chrome merges identical candidates into one).
//    Direct P2P usually works.
//  - "symmetric": different servers saw different ports (each destination gets its own mapping;
//    typical of 4G/5G CGNAT and some corporate networks). Hole punching to another NAT fails, so the
//    server sends the room to the SFU right away instead of waiting for an attempt to time out.
//  - "blocked": no public address at all (UDP/STUN blocked). Only the same LAN could work.
// v6: a public IPv6 route was seen (two IPv6 devices may connect even behind symmetric IPv4 NATs).
export async function probeNetwork({ timeoutMs = 3000, relay = false } = {}) {
  // Connection via relay forced on this device: no probe, the answer is "never direct".
  if (relay) return { nat: 'relay', v6: false };
  if (typeof RTCPeerConnection === 'undefined') return null;
  const lines = [];
  let complete = false;
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  try {
    pc.createDataChannel('probe');
    const done = new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      let settle = null;
      pc.onicecandidate = ({ candidate }) => {
        if (candidate?.candidate) {
          lines.push(candidate.candidate);
          // Gathering often never "completes" (one STUN server silent), but the servers that do
          // answer reply within a few hundred ms of each other: 1 s after the first public
          // address is enough to see whether another server got a different port.
          if (!settle && / typ srflx /.test(candidate.candidate)) settle = setTimeout(resolve, 1000);
        } else {
          complete = true;
          clearTimeout(timer);
          resolve();
        }
      };
    });
    await pc.setLocalDescription(await pc.createOffer());
    await done;
  } catch {
    return null;
  } finally {
    pc.close();
  }
  const ports = new Map(); // public IPv4 -> ports seen
  let v6 = false;
  for (const line of lines) {
    // candidate:<foundation> <component> <protocol> <priority> <address> <port> typ <type> ...
    const [, , protocol, , address = '', port, , type] = line.split(' ');
    if (String(protocol).toLowerCase() !== 'udp' || address.endsWith('.local')) continue;
    if (address.includes(':')) {
      if (!/^f[cd]|^fe80/i.test(address)) v6 = true;
      continue;
    }
    if (type !== 'srflx') continue;
    if (!ports.has(address)) ports.set(address, new Set());
    ports.get(address).add(port);
  }
  if (!ports.size) return complete || lines.length ? { nat: 'blocked', v6 } : null;
  const symmetric = [...ports.values()].some(set => set.size > 1) || ports.size > 1;
  return { nat: symmetric ? 'symmetric' : 'cone', v6 };
}

function newIceCount() {
  return { host: 0, srflx: 0, relay: 0, prflx: 0 };
}

// Counts an ICE candidate line ("candidate:... typ relay ...") by type. End-of-candidates is ignored.
function countIceCandidate(count, line) {
  const type = /\btyp (host|srflx|relay|prflx)\b/.exec(line || '')?.[1];
  if (count && type) count[type]++;
}
const MAX_ICE_RESTARTS = 3;
const POLL_INTERVAL_MS = 700;
const MAX_POLL_BACKOFF_MS = 8000;
// null = keep the source resolution
export const SHARE_RESOLUTIONS = {
  '480': { width: 854, height: 480, label: '480p' },
  '720': { width: 1280, height: 720, label: '720p' },
  '1080': { width: 1920, height: 1080, label: '1080p' },
  '1440': { width: 2560, height: 1440, label: '1440p' },
  source: { width: null, height: null, label: 'Fonte' }
};
export const SHARE_FPS = [15, 30, 60];
// Always tuned for games/video: the framerate is kept and the resolution gives way when the
// network or encoder can't keep up (a share that freezes is worse than a slightly softer one).
// Stream audio is always stereo Opus. WebRTC has no lossless codec: 510 kbps is Opus's ceiling.
export const SHARE_AUDIO_QUALITIES = {
  standard: { bitrate: 128_000, label: 'Normal', detail: '128 kbps' },
  high: { bitrate: 256_000, label: 'Alta', detail: '256 kbps' },
  max: { bitrate: 510_000, label: 'Máxima', detail: '510 kbps' }
};
export const DEFAULT_SHARE_SETTINGS = { resolution: '1080', fps: 60, audioQuality: 'max' };
const MIC_BITRATE = 64_000;

export function validShareSettings(value) {
  const v = value || {};
  return {
    resolution: SHARE_RESOLUTIONS[v.resolution] ? v.resolution : DEFAULT_SHARE_SETTINGS.resolution,
    fps: SHARE_FPS.includes(Number(v.fps)) ? Number(v.fps) : DEFAULT_SHARE_SETTINGS.fps,
    audioQuality: SHARE_AUDIO_QUALITIES[v.audioQuality] ? v.audioQuality : DEFAULT_SHARE_SETTINGS.audioQuality
  };
}

// H.264 first: it is the codec GPUs encode in hardware (AMD/NVIDIA/Intel via Media Foundation).
// VP8/VP9/AV1 usually run on the CPU (libvpx/libaom), which drops a game share to ~10 FPS when
// the game itself needs the CPU. Measured on an RX 9060 at 2580×1080: VP8 = libvpx, half
// resolution; H.264 = AMDh264Encoder, full resolution at 54+ FPS. If the other side has no
// H.264 (e.g. Firefox before its OpenH264 download), negotiation simply falls back to VP8.
function h264Rank(codec) {
  const fmtp = codec.sdpFmtpLine || '';
  const profile = (/profile-level-id=([0-9a-f]{4})/i.exec(fmtp)?.[1] || '').toLowerCase();
  const order = ['6400', '4d00', '42e0', '4200'];
  const p = order.indexOf(profile);
  return (/packetization-mode=1/.test(fmtp) ? 0 : 10) + (p < 0 ? 5 : p);
}

export function preferHardwareCodecs(transceivers) {
  let codecs;
  try {
    codecs = RTCRtpReceiver.getCapabilities?.('video')?.codecs;
  } catch { /* old browser */ }
  if (!codecs?.length) return;
  const h264 = codecs.filter(c => /^video\/h264$/i.test(c.mimeType)).sort((a, b) => h264Rank(a) - h264Rank(b));
  if (!h264.length) return;
  const ordered = [...h264, ...codecs.filter(c => !/^video\/h264$/i.test(c.mimeType))];
  for (const t of [transceivers.video, transceivers.camera]) {
    try { t?.setCodecPreferences?.(ordered); } catch { /* keep browser default */ }
  }
}

// Screen content needs strong minimum bitrate (2.5 Mbps) to avoid blurry text during BWE ramp-up
export const MAX_RECEIVE_BITRATE = 16_000_000;

export function targetBitrate(width, height, fps) {
  return Math.round(Math.min(MAX_RECEIVE_BITRATE, Math.max(2_500_000, width * height * fps * 0.08)));
}

// Enhances SDP for screen sharing:
// Sets initial start-bitrate at 4 Mbps (instead of Chrome's 300kbps default) and specifies
// b=AS/b=TIAS bandwidth limits. There is deliberately NO minimum bitrate: a floor stops the
// encoder from backing off when the link can't carry it, which congests the connection and
// makes the framerate stutter (worst in fast games).
// Also covers VP8 (which lacks an a=fmtp line by default in Chromium).
export function enhanceSdpForScreenShare(sdp, bitrateBps = 6_000_000) {
  if (!sdp || typeof sdp !== 'string') return sdp;
  const lines = sdp.split('\r\n');
  const bitrateKbps = Math.round(bitrateBps / 1000);
  let inVideo = false;
  const newLines = [];
  const primaryVideoPts = new Set();
  const fmtpHandledPts = new Set();

  function flushMissingFmtp() {
    for (const pt of primaryVideoPts) {
      if (!fmtpHandledPts.has(pt)) {
        newLines.push(`a=fmtp:${pt} x-google-start-bitrate=4000;x-google-max-bitrate=${bitrateKbps}`);
        fmtpHandledPts.add(pt);
      }
    }
  }

  for (let line of lines) {
    if (line.startsWith('m=video')) {
      inVideo = true;
      newLines.push(line);
      newLines.push(`b=AS:${bitrateKbps}`);
      newLines.push(`b=TIAS:${bitrateBps}`);
      continue;
    } else if (line.startsWith('m=')) {
      if (inVideo) flushMissingFmtp();
      inVideo = false;
    }

    if (inVideo && (line.startsWith('b=AS:') || line.startsWith('b=TIAS:'))) {
      continue;
    }

    if (inVideo && line.startsWith('a=rtpmap:')) {
      const match = line.match(/^a=rtpmap:(\d+)\s+([A-Za-z0-9_-]+)\//i);
      if (match) {
        const pt = match[1];
        const codec = match[2].toUpperCase();
        if (['VP8', 'VP9', 'H264', 'AV1', 'H265'].includes(codec)) {
          primaryVideoPts.add(pt);
        }
      }
    }

    if (inVideo && line.startsWith('a=fmtp:')) {
      const match = line.match(/^a=fmtp:(\d+)\s*(.*)$/);
      if (match) {
        const pt = match[1];
        fmtpHandledPts.add(pt);
        if (!line.includes('x-google-start-bitrate')) {
          const rest = match[2].trim();
          const sep = rest && !rest.endsWith(';') ? ';' : '';
          newLines.push(`a=fmtp:${pt} ${rest ? rest + sep : ''}x-google-start-bitrate=4000;x-google-max-bitrate=${bitrateKbps}`);
          continue;
        }
      }
    }

    newLines.push(line);
  }

  if (inVideo) flushMissingFmtp();

  return newLines.join('\r\n');
}

// Opus in every audio section: stereo both ways and room up to 510 kbps. The real bitrate of each
// sender is set with setParameters (stream audio by the chosen quality, the mic much lower).
// All audio sections get the same line because BUNDLE shares payload types between them.
const OPUS_PARAMS = { minptime: '10', useinbandfec: '1', stereo: '1', 'sprop-stereo': '1', maxaveragebitrate: '510000', maxplaybackrate: '48000', usedtx: '0' };

export function enhanceOpus(sdp) {
  if (!sdp || typeof sdp !== 'string') return sdp;
  return sdp.split(/(?=\r\nm=)/).map((section) => {
    if (!section.startsWith('\r\nm=audio')) return section;
    const pt = /\r\na=rtpmap:(\d+) opus\/48000/i.exec(section)?.[1];
    if (!pt) return section;
    const fmtp = new RegExp(`\\r\\na=fmtp:${pt} ([^\\r\\n]*)`);
    const found = fmtp.exec(section);
    const params = new Map();
    for (const part of (found?.[1] || '').split(';')) {
      const [key, value = ''] = part.split('=');
      if (key.trim()) params.set(key.trim(), value.trim());
    }
    for (const [key, value] of Object.entries(OPUS_PARAMS)) params.set(key, value);
    const line = `\r\na=fmtp:${pt} ${[...params].map(([k, v]) => `${k}=${v}`).join(';')}`;
    if (found) return section.replace(fmtp, () => line);
    return section.replace(new RegExp(`\\r\\na=rtpmap:${pt} [^\\r\\n]*`), (m) => m + line);
  }).join('');
}

export function enhanceSdp(description, bitrateBps = 6_000_000) {
  if (!description || !description.sdp) return description;
  return {
    type: description.type,
    sdp: enhanceOpus(enhanceSdpForScreenShare(description.sdp, bitrateBps))
  };
}

function randomId(prefix, length = 10) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return prefix + Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 'desktop' (the Windows/Linux app), 'mobile' (phones and tablets) or 'browser'.
export function detectDevice() {
  if (typeof window === 'undefined') return 'browser';
  if (window.kscreenDesktop?.isDesktop) return 'desktop';
  const ua = navigator.userAgent || '';
  const mobile = navigator.userAgentData?.mobile
    || /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua)
    || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1); // iPadOS asks for the desktop site
  return mobile ? 'mobile' : 'browser';
}

// --- Screen capture support (phones) ---

// Phones can't capture the screen from a web page: iOS has no getDisplayMedia in any browser, and
// Chrome for Android (still in 156) doesn't expose it either. Chrome for Android 72-88 exposed it
// but it always failed with NotAllowedError, which looks like the user cancelling the picker.
const ANDROID_CHROME_BROKEN_SHARE_MAX = 88;

function mobilePlatform() {
  const ua = navigator.userAgent || '';
  // iPadOS reports itself as a Mac: tell it apart by the touch screen.
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return null;
}

function androidChromeVersion() {
  const ua = navigator.userAgent || '';
  if (!/Android/i.test(ua)) return null;
  const m = ua.match(/Chrome\/(\d+)/);
  return m ? Number(m[1]) : null;
}

// The error message tells the person what they can do on their device.
export function screenShareUnsupported() {
  const platform = mobilePlatform();
  let message;
  if (platform === 'ios') {
    message = 'O iPhone e o iPad não deixam nenhum navegador compartilhar a tela (é uma limitação da Apple). Você ainda pode ligar a câmera, ou transmitir de um computador.';
  } else if (platform === 'android') {
    message = 'Os navegadores do Android não deixam sites compartilhar a tela, nem o Chrome mais novo. Você ainda pode ligar a câmera, ou transmitir de um computador.';
  } else {
    message = 'Este navegador não permite compartilhar a tela. Use o Chrome, Edge ou Firefox atualizado.';
  }
  const err = new Error(message);
  err.code = 'share-unsupported';
  return err;
}

function displayMediaFn() {
  if (navigator.mediaDevices?.getDisplayMedia) return (c) => navigator.mediaDevices.getDisplayMedia(c);
  // Legacy Edge (before Chromium) had it on navigator.
  if (navigator.getDisplayMedia) return (c) => navigator.getDisplayMedia(c);
  return null;
}

// Tries each set of options until one is accepted. Only "doesn't understand the request" errors
// move on; a cancel or a denied permission stops right away.
async function requestDisplayMedia(getDisplayMedia, attempts) {
  let lastErr;
  for (const options of attempts) {
    try {
      return await getDisplayMedia(options);
    } catch (err) {
      lastErr = err;
      if (!['TypeError', 'OverconstrainedError', 'NotSupportedError'].includes(err?.name)) break;
    }
  }
  const chrome = androidChromeVersion();
  if (lastErr?.name === 'NotAllowedError' && chrome && chrome <= ANDROID_CHROME_BROKEN_SHARE_MAX) throw screenShareUnsupported();
  if (lastErr?.name === 'NotSupportedError') throw screenShareUnsupported();
  throw lastErr;
}

export class P2PEngine {
  constructor(options = {}) {
    this.options = options;

    // peerId -> peer state (see createPeer)
    this.peers = new Map();
    // Room roster from the signaling server: peerId -> { id, name, avatarUrl }
    this.roster = new Map();
    // Candidates that arrive before their offer: `${peerId}:${connId}` -> candidates
    this.orphanedCandidates = new Map();
    // Per-target promise chain so signals to one peer leave in order
    this.outbox = new Map();
    // peerId -> timestamp until which a departed peer is not dialed back
    this.departed = new Map();
    // peerId -> { count, unreachable, since }: failed attempts in a row (survives rebuilds)
    this.linkFails = new Map();
    // State reported to the server with the poll (see localState)
    this.stateSeq = Date.now();
    this.lastStateJson = '';
    this.lastStateSentAt = 0;
    this.lastFailSent = '';

    this.myPeerId = randomId('p_');
    this.myPeerName = options.peerName || 'Você';
    // One instance per device kind in a room: desktop app, browser, phone.
    this.myDevice = detectDevice();
    this.onReplaced = options.onReplaced || (() => {});
    this.myAvatarUrl = options.avatarUrl || '/avatar.png';
    this.activeRoomId = null;
    // True only once the server accepted the join (activeRoomId is set while still trying).
    this.roomJoined = false;
    this.session = null;
    this.localStream = null;
    this.micStream = null;
    this.mic = null;
    this.micDeviceId = 'default';
    this.micVolume = 100;
    // Mic processing (set from the voice menu): our noise suppressor with a strength, and the
    // browser's echo cancellation. The browser's own noise suppression is only a fallback.
    this.noiseSuppression = true;
    this.noiseStrength = 80; // 0..100
    this.echoCancellation = true;
    this.noiseFallback = false; // RNNoise could not load: use the browser's suppressor
    this.cameraDeviceId = 'default';
    this.isMicMuted = true;
    this.isDeafened = false;
    this.isSpeaking = false;
    this.speakingDetector = null;
    this.cameraStream = null;
    this.lastStatus = 'closed';
    this.shareSettings = validShareSettings(options.shareSettings);
    this.shareAudioEnabled = true;
    // Discord-style: a stream only plays for whoever clicks "Assistir transmissão".
    // Ids of the streamers I watch; each peer tells everyone its own list.
    this.watching = new Set();
    this.previewTimers = [];

    this.statsInterval = null;
    this.pingInterval = null;

    // Callbacks
    this.onStatusChange = options.onStatusChange || (() => {});
    this.onPeersUpdate = options.onPeersUpdate || (() => {});
    this.onPeerStream = options.onPeerStream || (() => {});
    this.onPeerStreamEnded = options.onPeerStreamEnded || (() => {});
    this.onLocalStream = options.onLocalStream || (() => {});
    this.onShareSettingsChange = options.onShareSettingsChange || (() => {});
    this.onCapturePaused = options.onCapturePaused || (() => {});
    this.capturePaused = false;
    this.captureHidden = false; // last signal from the app (may arrive before the share is live)
    // Desktop app: a fullscreen game is captured through its monitor; while the game isn't in
    // front (alt-tab, desktop) the video goes black so nothing else on that monitor leaks.
    window.kscreenDesktop?.share?.onPaused?.((paused) => this.setCapturePaused(paused));
    this.onScreenShareEnded = options.onScreenShareEnded || (() => {});
    this.onLog = options.onLog || (() => {});
    this.onPeerMessage = options.onPeerMessage || (() => {});
    this.onFileChannel = options.onFileChannel || (() => {});
    this.onAuthRequired = options.onAuthRequired || (() => {});
    this.onVoiceStateChange = options.onVoiceStateChange || (() => {});

    // Network probe (see probeNetwork): started now so it is ready by the time we join a room.
    this.net = null;
    this.netAt = 0;
    this.netProbe = null;
    this.lastNetSent = '';
    if (typeof window !== 'undefined') {
      this.refreshNetwork();
      // Wi-Fi <-> mobile data, VPN on/off: the NAT may be another one now.
      navigator.connection?.addEventListener?.('change', () => this.refreshNetwork(true));
      window.addEventListener('online', () => this.refreshNetwork(true));
    }

    if (typeof window !== 'undefined') {
      // The data channel "bye" reaches peers even when the beacon is dropped.
      window.addEventListener('pagehide', () => {
        this.broadcast({ type: 'bye' });
        this.sendLeaveBeacon();
      });
    }
  }

  log(message, level = 'info') {
    this.onLog({ message, level, time: Date.now() });
  }

  setStatus(status) {
    if (status === this.lastStatus) return;
    this.lastStatus = status;
    this.onStatusChange(status);
  }

  refreshStatus() {
    if (!this.activeRoomId) return this.setStatus('closed');
    const states = [...this.peers.values()].map(p => p.status);
    if (states.includes('connected')) this.setStatus('connected');
    else if (states.length) this.setStatus('connecting');
    else this.setStatus('waiting');
  }

  // --- ROOM LIFECYCLE ---

  // password: only for rooms created with one. Kept for automatic re-joins.
  // fresh: a typed code or invite link; the server answers ROOM_NOT_FOUND instead of creating it.
  async joinRoom(roomId, peerName = this.myPeerName, avatarUrl = this.myAvatarUrl, { password = '', fresh = false } = {}) {
    this.disconnect({ quiet: true });

    const cleanRoomId = String(roomId || '').trim();
    if (!cleanRoomId) throw new Error('Código de sala inválido');
    this.roomPassword = password;
    this.roomMaxPeers = 0; // learned from the join reply
    this.joinFresh = fresh; // only the first register; re-joins after a restart recreate the room

    this.myPeerName = peerName || 'Você';
    this.myAvatarUrl = avatarUrl || '/avatar.png';
    this.myPeerId = randomId('p_');
    this.activeRoomId = cleanRoomId;
    const session = {};
    this.session = session;
    this.setStatus('connecting');
    this.log(`Entrando na sala ${cleanRoomId} como "${this.myPeerName}"...`);

    try {
      const data = await this.register();
      if (this.session !== session) return cleanRoomId;
      this.activeRoomId = data.roomId || cleanRoomId;
      this.roomJoined = true;
      this.roomLocked = !!data.locked;
      this.log(`Conectado à sala ${this.activeRoomId}. Participantes: ${data.existingPeers.length + 1}`, 'success');
      this.syncRoster(data.existingPeers, true);
    } catch (err) {
      if (this.session === session) this.disconnect({ quiet: true });
      throw err;
    }

    this.pollLoop(session);
    this.startStatsMonitoring();
    this.refreshStatus();
    this.notifyPeersUpdate();
    return this.activeRoomId;
  }

  async createRoom(peerName = this.myPeerName, avatarUrl = this.myAvatarUrl, { password = '', maxPeers = 0, code = '' } = {}) {
    this.log(password ? 'Gerando nova sala com senha...' : 'Gerando nova sala...');
    const res = await fetch('/api/room/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...this.joinExtras(), ...(password ? { password } : {}), ...(maxPeers ? { maxPeers } : {}), ...(code ? { code } : {}) })
    });
    if (res.status === 401) {
      this.onAuthRequired();
      throw new Error('Login necessário.');
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw Object.assign(new Error(err.error || 'Servidor de sinalização indisponível.'), { status: res.status, code: err.code });
    }
    const { roomId } = await res.json();
    return this.joinRoom(roomId, peerName, avatarUrl, { password });
  }

  // Extra fields for /api/room/create and /join (capabilities): see sfu-engine.js.
  joinExtras() {
    return {};
  }

  // How many viewers share the upload of our screen (mesh: one copy per viewer).
  bitrateViewers() {
    return Math.max(1, [...this.peers.values()].filter(p => p.status === 'connected' && this.isWatchedBy(p)).length);
  }

  async register() {
    // The server decides P2P or SFU on join: give it our network type if the probe is (nearly) done.
    await Promise.race([this.refreshNetwork(), sleep(NET_PROBE_WAIT_MS)]);
    const res = await fetch('/api/room/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId: this.activeRoomId,
        peerId: this.myPeerId,
        peerName: this.myPeerName,
        avatarUrl: this.myAvatarUrl,
        device: this.myDevice,
        ...(this.netString() ? { net: this.netString() } : {}),
        ...this.joinExtras(),
        ...(this.roomPassword ? { password: this.roomPassword } : {}),
        ...(this.joinFresh ? { fresh: true } : {}),
        // After a server restart the room is recreated by whoever re-joins first: password and
        // people limit come back with it.
        ...(this.roomMaxPeers ? { maxPeers: this.roomMaxPeers } : {})
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 401) this.onAuthRequired();
      // code: PASSWORD_REQUIRED / PASSWORD_WRONG / TOO_MANY for protected rooms
      throw Object.assign(new Error(err.error || 'Falha ao registrar na sala.'), { status: res.status, code: err.code });
    }
    const data = await res.json();
    this.joinFresh = false;
    if (data.maxPeers) this.roomMaxPeers = data.maxPeers;
    // The server may have lost what we told it (restart): send everything again.
    this.lastStateJson = '';
    this.lastFailSent = '';
    this.lastNetSent = this.netString();
    return data;
  }

  refreshNetwork(force = false) {
    // One probe at a time (callers may ask again every poll while it runs).
    if (this.netProbing) return this.netProbe;
    if (!force && this.netProbe && Date.now() - this.netAt < NET_PROBE_MAX_AGE_MS) return this.netProbe;
    this.netProbing = true;
    const probe = probeNetwork({ relay: this.forceRelay() }).then((net) => {
      this.netProbing = false;
      if (this.netProbe !== probe) return this.net;
      const before = this.netString();
      // A probe that got nothing (offline for a moment) keeps the last answer.
      if (net) this.net = net;
      this.netAt = Date.now();
      if (net && this.netString() !== before) {
        const label = { cone: 'P2P direto deve funcionar', symmetric: 'NAT simétrico (comum em 4G/5G): P2P direto quase nunca funciona, salas com outras pessoas usam o servidor de mídia', blocked: 'sem UDP/STUN: P2P direto só na mesma rede', relay: 'conexão via relay (servidor de mídia)' }[net.nat];
        this.log(`Rede: ${label}${net.v6 ? ' (tem IPv6)' : ''}.`, net.nat === 'cone' ? 'info' : 'warn');
      }
      return net;
    }).catch(() => {
      this.netProbing = false;
      return null;
    });
    this.netProbe = probe;
    return probe;
  }

  // "symmetric.1" = NAT type + public IPv6, for the server's prediction (server/sfu-nodes.js).
  netString() {
    return this.net ? `${this.net.nat}.${this.net.v6 ? 1 : 0}` : '';
  }

  // What everyone should know about us even without a connection to us: it goes to the server
  // with the poll and comes back to the others in the roster (see applyServerState).
  localState() {
    return {
      s: !!this.localStream,
      a: !!this.localStream?.getAudioTracks().length,
      m: this.isMicMuted,
      d: this.isDeafened,
      c: !!this.cameraStream,
      w: [...this.watching].slice(0, 32)
    };
  }

  // Extra query for the poll: state (when it changed or now and then) and pairs that never connect.
  pollQuery() {
    let query = '';
    const json = JSON.stringify(this.localState());
    if (json !== this.lastStateJson || Date.now() - this.lastStateSentAt > STATE_REFRESH_MS) {
      if (json !== this.lastStateJson) this.stateSeq = Math.max(this.stateSeq + 1, Date.now());
      this.lastStateJson = json;
      this.lastStateSentAt = Date.now();
      query += `&st=${encodeURIComponent(JSON.stringify({ v: this.stateSeq, ...JSON.parse(json) }))}`;
    }
    const net = this.netString();
    if (net && net !== this.lastNetSent) {
      this.lastNetSent = net;
      query += `&net=${net}`;
    }
    const fails = this.failReport().join(',');
    if (fails !== this.lastFailSent) {
      this.lastFailSent = fails;
      query += `&fail=${encodeURIComponent(fails)}`;
    }
    return query;
  }

  // Ids we can't connect to at all (both tries failed), for the server.
  failReport() {
    return [...this.linkFails].filter(([id, f]) => f.unreachable && this.roster.has(id)).map(([id]) => id).slice(0, 16);
  }

  // Extra fields of the poll answer (room mode, media server): see sfu-engine.js.
  handlePollExtras() {}

  // Sequential loop: signals are always processed in order and requests never overlap.
  async pollLoop(session) {
    let failures = 0;
    while (this.session === session) {
      let delay = POLL_INTERVAL_MS;
      try {
        const routes = this.routeReport();
        const res = await fetch(`/api/room/poll?roomId=${encodeURIComponent(this.activeRoomId)}&peerId=${this.myPeerId}${routes ? `&routes=${encodeURIComponent(routes)}` : ''}${this.pollQuery()}`, { cache: 'no-store' });
        if (this.session !== session) return;
        if (res.status === 401) {
          // Session cookie expired or was revoked: stop instead of retrying forever.
          this.log('Sessão do Discord expirou.', 'error');
          this.onAuthRequired();
          return;
        }
        if (res.status === 409) {
          // The same account joined this room from another instance of this device kind.
          const err = await res.json().catch(() => ({}));
          if (err.code === 'REPLACED') {
            this.log('Você entrou nesta sala em outra janela deste dispositivo.', 'warn');
            this.onReplaced(err.device || this.myDevice);
            return;
          }
          throw new Error('HTTP 409');
        }
        if (res.status === 404) {
          // Server restarted or timed us out (e.g. a long-throttled background tab): re-join silently.
          const err = await res.json().catch(() => ({}));
          if (err.code !== 'MODE_CHANGED') this.log('Sessão de sinalização expirou. Reentrando na sala...', 'warn');
          await this.register();
          failures = 0;
        } else if (res.ok) {
          const data = await res.json();
          if (this.session !== session) return;
          // Mode first: an offer for the P2P mesh can come in the same answer that tells us the
          // room left the SFU, and a page still in SFU mode drops mesh signals.
          this.handlePollExtras(data);
          for (const msg of data.signals || []) {
            try {
              await this.handleIncomingSignal(msg);
            } catch (err) {
              this.log(`Sinal de ${this.peerName(msg.fromPeerId)} ignorado: ${err.message}`, 'warn');
            }
          }
          this.syncRoster((data.peers || []).filter(p => p.id !== this.myPeerId));
          this.checkStuckPeers();
          failures = 0;
        } else {
          throw new Error(`HTTP ${res.status}`);
        }
      } catch (err) {
        failures++;
        delay = Math.min(MAX_POLL_BACKOFF_MS, POLL_INTERVAL_MS * 2 ** failures);
        if (failures === 3) this.log('Servidor de sinalização instável. As conexões P2P já abertas continuam funcionando.', 'warn');
      }
      await sleep(delay);
    }
  }

  // The peer with the smaller id always initiates, so each pair opens exactly one connection.
  syncRoster(list, initial = false) {
    const present = new Set();
    const now = Date.now();
    for (const [id, until] of this.departed) {
      if (until < now) this.departed.delete(id);
    }
    for (const info of list) {
      if (!info?.id || info.id === this.myPeerId || this.departed.has(info.id)) continue;
      present.add(info.id);
      this.roster.set(info.id, info);
      const peer = this.peers.get(info.id);
      if (peer) {
        peer.missing = 0;
        peer.name = info.name || peer.name;
        peer.avatarUrl = info.avatarUrl || peer.avatarUrl;
        peer.device = info.device || peer.device;
        // No control channel with them (yet, or ever): the server's copy of their state is all
        // we have. With the channel open, its messages are newer and win.
        if (info.state && peer.dc?.readyState !== 'open') this.applyServerState(peer, info.state);
      } else if (this.myPeerId < info.id && !this.linkFails.get(info.id)?.waiting) {
        this.connectTo(info);
      }
    }
    if (initial) return;
    for (const id of [...this.roster.keys()]) {
      if (!present.has(id)) {
        this.roster.delete(id);
        this.linkFails.delete(id);
      }
    }
    for (const [id, peer] of this.peers) {
      // Two consecutive absences avoid racing a peer that is joining right now.
      if (!present.has(id) && ++peer.missing >= 2) {
        this.log(`"${peer.name}" saiu da sala.`);
        this.removePeer(id);
      }
    }
  }

  peerName(id) {
    return this.peers.get(id)?.name || this.roster.get(id)?.name || 'participante';
  }

  // --- SIGNAL TRANSPORT ---

  sendSignal(toPeerId, type, payload) {
    const roomId = this.activeRoomId;
    const fromPeerId = this.myPeerId;
    const previous = this.outbox.get(toPeerId) || Promise.resolve();
    const next = previous.then(async () => {
      if (!roomId || roomId !== this.activeRoomId) return;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch('/api/room/signal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomId, fromPeerId, toPeerId, type, payload })
          });
          if (res.status === 400) return;
          // success: false = they aren't registered (yet): a joining peer may be a moment away.
          if (res.ok && (await res.json().catch(() => ({}))).success !== false) return;
        } catch { /* retried below */ }
        await sleep(400 * (attempt + 1));
      }
    });
    this.outbox.set(toPeerId, next);
    next.finally(() => {
      if (this.outbox.get(toPeerId) === next) this.outbox.delete(toPeerId);
    });
    return next;
  }

  async handleIncomingSignal(msg) {
    const { fromPeerId, type, payload } = msg || {};
    if (!fromPeerId || fromPeerId === this.myPeerId || !payload?.connId) return;
    let peer = this.peers.get(fromPeerId);

    // Older pages may still open their chat-media TURN link (same connId, lane "files"): its
    // offer/answer/candidates must never reach the main connection (an offer there would replace
    // the main session description). We don't answer it; they keep media on the main connection.
    if (payload.lane) return;

    if (type === 'redial') {
      this.handleRedial(fromPeerId, peer);
      return;
    }

    if (type === 'offer') {
      if (peer && peer.connId !== payload.connId) {
        // The other side rebuilt its connection: replace ours.
        this.removePeer(fromPeerId, { keepStream: true });
        peer = null;
      }
      if (!peer) {
        const info = { ...(this.roster.get(fromPeerId) || {}), id: fromPeerId };
        if (payload.name) info.name = payload.name;
        peer = this.createPeer(info, payload.connId, false);
      }
      await this.handleDescription(peer, payload.description);
      return;
    }

    if (!peer || peer.connId !== payload.connId) {
      if (type === 'candidate') {
        const key = `${fromPeerId}:${payload.connId}`;
        const list = this.orphanedCandidates.get(key) || [];
        if (list.length < 50) list.push(payload.candidate);
        this.orphanedCandidates.set(key, list);
      }
      return;
    }

    if (type === 'answer') {
      await this.handleDescription(peer, payload.description);
    } else if (type === 'candidate') {
      await this.addCandidate(peer, payload.candidate);
    } else if (type === 'bye') {
      this.markDeparted(fromPeerId);
      this.removePeer(fromPeerId);
    }
  }

  // The server roster can still list a peer that just said goodbye (until its
  // 60 s timeout if the leave request was lost); don't dial it back meanwhile.
  markDeparted(peerId) {
    if (this.peers.has(peerId)) this.log(`"${this.peerName(peerId)}" saiu da sala.`);
    this.departed.set(peerId, Date.now() + 75000);
    this.roster.delete(peerId);
  }

  async handleDescription(peer, description) {
    const { pc } = peer;
    if (!description?.type || typeof description.sdp !== 'string') return;
    const offerCollision = description.type === 'offer'
      && (peer.makingOffer || pc.signalingState !== 'stable');
    peer.ignoreOffer = !peer.polite && offerCollision;
    if (peer.ignoreOffer) {
      this.log(`Colisão de oferta com "${peer.name}" resolvida (mantendo a nossa).`);
      return;
    }
    if (description.type === 'answer' && pc.signalingState !== 'have-local-offer') return;

    const bitrate = this.getTargetBitrate();
    const remoteDesc = enhanceSdp(description, bitrate);
    await pc.setRemoteDescription(remoteDesc);
    this.bindTransceivers(peer);
    await this.flushCandidates(peer);

    if (description.type === 'offer') {
      // Our own description must say stereo too, or Chrome decodes the stream audio as mono.
      const answer = await pc.createAnswer();
      await pc.setLocalDescription({ type: 'answer', sdp: enhanceOpus(answer.sdp) });
      // Our answer's b=AS caps the sender: never limit it by OUR own share settings.
      const localDesc = enhanceSdp(pc.localDescription, MAX_RECEIVE_BITRATE);
      this.sendSignal(peer.id, 'answer', { connId: peer.connId, description: localDesc });
    }
    if (this.localStream) {
      this.applyVideoEncoding(peer);
    }
  }

  async addCandidate(peer, candidate) {
    if (!candidate) return;
    countIceCandidate(peer.ice?.remote, candidate.candidate);
    if (!peer.pc.remoteDescription) {
      peer.pendingCandidates.push(candidate);
      return;
    }
    try {
      await peer.pc.addIceCandidate(candidate);
    } catch (err) {
      if (!peer.ignoreOffer) this.log(`Candidato de "${peer.name}" recusado: ${err.message}`, 'warn');
    }
  }

  async flushCandidates(peer) {
    const key = `${peer.id}:${peer.connId}`;
    const orphaned = this.orphanedCandidates.get(key) || [];
    this.orphanedCandidates.delete(key);
    const candidates = [...orphaned, ...peer.pendingCandidates];
    peer.pendingCandidates = [];
    for (const candidate of candidates) await this.addCandidate(peer, candidate);
  }

  // --- PEER CONNECTION MANAGEMENT ---

  connectTo(info) {
    this.log(`Abrindo conexão P2P com "${info.name || 'participante'}"...`);
    return this.createPeer(info, randomId('c_', 8), true);
  }

  // "Forçar conexão via relay" (hidden setting, localStorage kscreen.forceRelay = '1'): this device
  // never connects directly. It reports the network as "relay" (see probeNetwork), so the server
  // puts its rooms in the SFU right away; direct attempts get no candidates at all (relay policy
  // with no relay server), in case a room is still in P2P.
  forceRelay() {
    try {
      return localStorage.getItem(FORCE_RELAY_KEY) === '1';
    } catch {
      return false;
    }
  }

  createPeer(info, connId, initiator) {
    const blocked = this.forceRelay();
    const pc = new RTCPeerConnection({
      iceServers: blocked ? [] : ICE_SERVERS,
      bundlePolicy: 'max-bundle',
      iceTransportPolicy: blocked ? 'relay' : 'all'
    });
    const peer = {
      id: info.id,
      name: info.name || `Usuário-${info.id.slice(-4)}`,
      avatarUrl: info.avatarUrl || '/avatar.png',
      connId,
      initiator,
      // The initiator is "impolite": in a glare its offer wins.
      polite: !initiator,
      pc,
      dc: null,
      makingOffer: false,
      ignoreOffer: false,
      pendingCandidates: [],
      transceivers: null,
      remoteStream: new MediaStream(),
      // Separate streams so a <video> never has to guess between screen and camera
      screenStream: null,
      cameraStream: null,
      isStreaming: false,
      remoteHasAudio: false,
      // Voice state reported by the peer itself (Discord-style mute/deafen/speaking)
      micMuted: true,
      deafened: false,
      speaking: false,
      cameraOn: false,
      // Streamer ids this peer watches; nothing is sent to it until it watches us.
      watching: new Set(),
      // Still frame of its stream while we don't watch it
      preview: null,
      status: this.linkFails.get(info.id)?.unreachable ? 'failed' : 'connecting',
      missing: 0,
      iceRestarts: 0,
      // ICE diagnostics: candidate types seen on each side and STUN errors, logged on timeout.
      ice: { local: newIceCount(), remote: newIceCount(), errors: new Map() },
      createdAt: Date.now(),
      timers: {},
      stats: { pingMs: 0, rttMs: 0, isIpv6: false, isRelay: false, connectionShort: 'Conectando...', connectionName: 'Estabelecendo rota P2P' }
    };
    this.peers.set(peer.id, peer);

    // Pre-negotiated channel: both sides create it, no ondatachannel race.
    this.setupDataChannel(peer, pc.createDataChannel('control', { negotiated: true, id: 0 }));
    // Chat media (src/p2p-files.js): its own channel so big transfers never delay control messages.
    peer.fileDc = pc.createDataChannel('files', { negotiated: true, id: 1 });
    peer.fileDc.binaryType = 'arraybuffer';
    peer.directFileDc = peer.fileDc;
    this.onFileChannel(peer, peer.fileDc);

    if (initiator) {
      // Fixed m-line order: screen video, screen audio, mic, camera. The responder maps by the same order.
      const videoTrack = this.localStream?.getVideoTracks()[0] || null;
      const screenAudioTrack = this.localStream?.getAudioTracks()[0] || null;
      const micTrack = this.micStream?.getAudioTracks()[0] || null;
      const cameraTrack = this.cameraStream?.getVideoTracks()[0] || null;
      const video = pc.addTransceiver(videoTrack || 'video', { direction: 'sendrecv' });
      const screenAudio = pc.addTransceiver(screenAudioTrack || 'audio', { direction: 'sendrecv' });
      const mic = pc.addTransceiver(micTrack || 'audio', { direction: 'sendrecv' });
      const camera = pc.addTransceiver(cameraTrack || 'video', { direction: 'sendrecv' });
      peer.transceivers = { video, screenAudio, mic, camera };
      preferHardwareCodecs(peer.transceivers);
      this.bindRemoteVideoStreams(peer);
      this.attachLocalTracks(peer);
    }

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        const offer = await pc.createOffer();
        if (pc.signalingState !== 'stable') return; // an offer from them arrived meanwhile
        await pc.setLocalDescription({ type: 'offer', sdp: enhanceOpus(offer.sdp) });
        // The b=AS we send caps what the OTHER side may send us: always advertise the ceiling.
        const desc = enhanceSdp(pc.localDescription, MAX_RECEIVE_BITRATE);
        this.sendSignal(peer.id, 'offer', { connId, name: this.myPeerName, description: desc });
      } catch (err) {
        this.log(`Falha ao criar oferta para "${peer.name}": ${err.message}`, 'warn');
      } finally {
        peer.makingOffer = false;
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) countIceCandidate(peer.ice.local, candidate.candidate);
      if (candidate && this.peers.get(peer.id) === peer) {
        this.sendSignal(peer.id, 'candidate', { connId, candidate: candidate.toJSON() });
      }
    };

    pc.ontrack = (event) => this.handleRemoteTrack(peer, event.track);
    pc.onconnectionstatechange = () => this.handleConnectionState(peer);
    pc.onicecandidateerror = (event) => {
      // Only server errors matter (STUN unreachable...). Kept for the diagnosis, once per url+code.
      const url = event.url || '';
      if (!url) return;
      const key = `${url}|${event.errorCode}`;
      if (peer.ice.errors.has(key)) return;
      peer.ice.errors.set(key, `${url} → ${event.errorCode} ${event.errorText || ''}`.trim());
    };

    // A connection that never gets anywhere is rebuilt from scratch by the initiator. The other
    // side can't rebuild (two offers would cross): it asks the initiator to (redial).
    peer.timers.connect = setTimeout(() => {
      if (this.peers.get(peer.id) !== peer || peer.status === 'connected' || peer.pc.connectionState === 'connected') return;
      if (peer.initiator) {
        this.log(`Conexão com "${peer.name}" não respondeu. Recomeçando...`, 'warn');
        this.logIceDiagnosis(peer);
        this.rebuildPeer(peer.id, { failed: true });
      } else {
        this.responderStuck(peer);
      }
    }, initiator ? CONNECT_TIMEOUT_MS : RESPONDER_TIMEOUT_MS);

    this.notifyPeersUpdate();
    return peer;
  }

  // Responder side: transceivers are created by the remote offer, in m-line order.
  bindTransceivers(peer) {
    if (peer.transceivers) return;
    const list = peer.pc.getTransceivers();
    const videos = list.filter(t => t.receiver.track?.kind === 'video');
    const audios = list.filter(t => t.receiver.track?.kind === 'audio');
    if (!videos.length) return;
    // An older client offers no camera m-line: camera stays null and simply isn't shown.
    peer.transceivers = { video: videos[0], screenAudio: audios[0] || null, mic: audios[1] || null, camera: videos[1] || null };
    for (const transceiver of Object.values(peer.transceivers)) {
      if (transceiver) transceiver.direction = 'sendrecv';
    }
    preferHardwareCodecs(peer.transceivers);
    this.bindRemoteVideoStreams(peer);
    this.attachLocalTracks(peer);
  }

  // A transceiver's receiver track never changes, so these streams are built once.
  bindRemoteVideoStreams(peer) {
    const t = peer.transceivers;
    peer.screenStream = new MediaStream([t.video.receiver.track]);
    peer.cameraStream = t.camera ? new MediaStream([t.camera.receiver.track]) : null;
  }

  attachLocalTracks(peer) {
    const t = peer.transceivers;
    if (!t) return;
    // Nobody pays for a stream they aren't watching: the screen goes only to its viewers.
    const watched = this.isWatchedBy(peer);
    const video = watched ? this.localStream?.getVideoTracks()[0] || null : null;
    const screenAudio = watched ? this.localStream?.getAudioTracks()[0] || null : null;
    const mic = this.micStream?.getAudioTracks()[0] || null;
    const camera = this.cameraStream?.getVideoTracks()[0] || null;
    const replace = (transceiver, track) => {
      if (!transceiver || transceiver.sender.track === track) return;
      transceiver.sender.replaceTrack(track).catch(err => this.log(`replaceTrack falhou com "${peer.name}": ${err.message}`, 'warn'));
    };
    replace(t.video, video);
    replace(t.screenAudio, screenAudio);
    replace(t.mic, mic);
    replace(t.camera, camera);
    if (video) this.applyVideoEncoding(peer);
    if (camera) this.applyCameraEncoding(peer);
    if (screenAudio || mic) this.applyAudioEncoding(peer);
  }

  isWatchedBy(peer) {
    return !!peer?.watching?.has(this.myPeerId);
  }

  // Stream audio at the chosen quality; the mic stays at a voice bitrate.
  async applyAudioEncoding(peer) {
    const t = peer.transceivers;
    const quality = SHARE_AUDIO_QUALITIES[this.shareSettings.audioQuality] || SHARE_AUDIO_QUALITIES.max;
    const apply = async (sender, bitrate) => {
      if (!sender) return;
      try {
        const params = sender.getParameters();
        if (!params?.encodings?.length) return;
        params.encodings[0].maxBitrate = bitrate;
        params.encodings[0].priority = 'high';
        params.encodings[0].networkPriority = 'high';
        await sender.setParameters(params);
      } catch { /* Not negotiated yet; applied again once connected. */ }
    };
    await apply(t?.screenAudio?.sender, quality.bitrate);
    await apply(t?.mic?.sender, MIC_BITRATE);
  }

  // Camera is secondary to the screen: modest bitrate, and it may drop resolution under pressure.
  async applyCameraEncoding(peer) {
    const sender = peer.transceivers?.camera?.sender;
    if (!sender?.track) return;
    try {
      const params = sender.getParameters();
      if (!params?.encodings?.length) return;
      params.encodings[0].maxBitrate = 1_200_000;
      params.encodings[0].maxFramerate = 30;
      await sender.setParameters(params);
    } catch { /* Not negotiated yet; applied again once connected. */ }
  }

  getTargetBitrate() {
    const { fps, resolution } = this.shareSettings;
    const track = this.localStream?.getVideoTracks()[0];
    const actual = track?.getSettings() || {};
    const preset = SHARE_RESOLUTIONS[resolution] || SHARE_RESOLUTIONS[DEFAULT_SHARE_SETTINGS.resolution];
    const width = actual.width || preset.width || 1920;
    const height = actual.height || preset.height || 1080;
    const viewers = this.bitrateViewers();
    const perViewer = viewers > 1 ? 1.5 / Math.min(viewers, 4) : 1;
    return Math.round(targetBitrate(width, height, fps) * perViewer);
  }

  async applyVideoEncoding(peer) {
    const sender = peer.transceivers?.video?.sender;
    const track = this.localStream?.getVideoTracks()[0];
    if (!sender || !track) return;
    try {
      const params = sender.getParameters();
      if (!params?.encodings?.length) return;
      const { fps } = this.shareSettings;
      params.encodings[0].maxBitrate = this.getTargetBitrate();
      params.encodings[0].maxFramerate = fps;
      // Never lock the scale: the encoder drops resolution to keep the FPS steady.
      delete params.encodings[0].scaleResolutionDownBy;
      try {
        params.degradationPreference = 'maintain-framerate';
      } catch { /* read-only in some browsers */ }

      try {
        await sender.setParameters(params);
      } catch {
        // Retry without degradationPreference if the browser rejected that specific field
        delete params.degradationPreference;
        await sender.setParameters(params).catch(() => {});
      }
    } catch { /* Not negotiated yet; applied again once connected. */ }
  }

  videoConstraints() {
    const { resolution, fps } = this.shareSettings;
    const preset = SHARE_RESOLUTIONS[resolution] || SHARE_RESOLUTIONS[DEFAULT_SHARE_SETTINGS.resolution];
    const constraints = { frameRate: { ideal: fps, max: fps } };
    if (preset.width) {
      // Limit by height only ("1080p" = 1080 lines) and never ask for an exact width:
      // with ideal width AND height browsers output exactly 16:9 and letterbox ultrawide screens.
      // The width cap (32:9) only guards against absurd multi-monitor captures.
      constraints.height = { max: preset.height };
      constraints.width = { max: Math.round(preset.height * 32 / 9) };
    }
    return constraints;
  }

  // Can be called mid-share: the capture is rescaled in place, no renegotiation.
  async setShareSettings(settings) {
    const merged = { ...this.shareSettings, ...settings };
    if (!SHARE_RESOLUTIONS[merged.resolution] || !SHARE_FPS.includes(merged.fps) || !SHARE_AUDIO_QUALITIES[merged.audioQuality]) throw new Error('Configuração inválida');
    const next = validShareSettings(merged);
    const audioChanged = next.audioQuality !== this.shareSettings.audioQuality;
    this.shareSettings = next;
    if (audioChanged) {
      await Promise.all([...this.peers.values()].map(peer => this.applyAudioEncoding(peer)));
      this.log(`Áudio da transmissão: ${SHARE_AUDIO_QUALITIES[next.audioQuality].detail}, estéreo.`, 'success');
      if (!('resolution' in settings) && !('fps' in settings)) return next;
    }
    const track = this.localStream?.getVideoTracks()[0];
    if (!track) return next;
    try {
      // Constraints are replaced wholesale, so "Original" drops the size limits.
      await track.applyConstraints(this.videoConstraints());
    } catch (err) {
      this.log(`O navegador não aceitou ${SHARE_RESOLUTIONS[next.resolution].label} a ${next.fps} FPS: ${err.message}`, 'warn');
    }
    await Promise.all([...this.peers.values()].map(peer => this.applyVideoEncoding(peer)));
    const actual = track.getSettings();
    this.log(`Qualidade da transmissão: ${actual.width || '?'}×${actual.height || '?'} a ${next.fps} FPS.`, 'success');
    return next;
  }

  handleRemoteTrack(peer, track) {
    if (!peer.remoteStream.getTracks().includes(track)) peer.remoteStream.addTrack(track);
    if (track.kind === 'audio') peer.remoteHasAudio = true;
    track.onunmute = () => {
      if (track.kind === 'video' && !peer.statusFromChannel) peer.isStreaming = true;
      this.onPeerStream(peer.id, peer.remoteStream, track, peer);
      this.notifyPeersUpdate();
    };
    track.onended = () => {
      try { peer.remoteStream.removeTrack(track); } catch { /* already removed */ }
      this.onPeerStreamEnded(peer.id, track.kind);
      this.notifyPeersUpdate();
    };
  }

  handleConnectionState(peer) {
    if (this.peers.get(peer.id) !== peer) return;
    const state = peer.pc.connectionState;
    clearTimeout(peer.timers.disconnect);

    if (state === 'connected') {
      clearTimeout(peer.timers.connect);
      if (peer.status !== 'connected') this.log(`Conexão P2P com "${peer.name}" estabelecida.`, 'success');
      peer.status = 'connected';
      peer.iceRestarts = 0;
      peer.rebuilds = 0;
      if (this.linkFails.has(peer.id)) {
        this.linkFails.delete(peer.id);
        this.log(`Conexão com "${peer.name}" recuperada.`, 'success');
      }
      clearTimeout(peer.timers.restart);
      if (this.localStream) this.applyVideoEncoding(peer);
      if (this.cameraStream) this.applyCameraEncoding(peer);
      this.applyAudioEncoding(peer);
    } else if (state === 'disconnected') {
      peer.status = 'reconnecting';
      this.log(`Conexão com "${peer.name}" instável. Aguardando recuperação...`, 'warn');
      peer.timers.disconnect = setTimeout(() => {
        if (peer.pc.connectionState === 'disconnected') this.recoverPeer(peer);
      }, DISCONNECT_GRACE_MS);
    } else if (state === 'failed') {
      peer.status = 'reconnecting';
      this.recoverPeer(peer);
    } else if (state === 'connecting' || state === 'new') {
      if (peer.status !== 'reconnecting' && peer.status !== 'failed') peer.status = 'connecting';
    }
    this.refreshStatus();
    this.notifyPeersUpdate();
  }

  // Only the initiator drives recovery so both sides never restart at once.
  recoverPeer(peer) {
    if (this.peers.get(peer.id) !== peer || !peer.initiator) return;
    if (peer.iceRestarts >= MAX_ICE_RESTARTS) {
      this.log(`Rota com "${peer.name}" não se recuperou. Recriando a conexão...`, 'warn');
      this.logIceDiagnosis(peer);
      this.rebuildPeer(peer.id, { failed: true });
      return;
    }
    peer.iceRestarts++;
    this.log(`Renovando rotas ICE com "${peer.name}" (${peer.iceRestarts}/${MAX_ICE_RESTARTS})...`, 'warn');
    peer.pc.restartIce();
    clearTimeout(peer.timers.restart);
    peer.timers.restart = setTimeout(() => {
      if (this.peers.get(peer.id) === peer && peer.pc.connectionState !== 'connected') this.recoverPeer(peer);
    }, RESTART_WATCHDOG_MS);
  }

  // Explains in the log why a connection never got a route: which candidate types each side
  // gathered and the most likely cause.
  logIceDiagnosis(peer) {
    const { local, remote, errors } = peer.ice;
    const fmt = (c) => `host ${c.host}, srflx ${c.srflx}, relay ${c.relay}${c.prflx ? `, prflx ${c.prflx}` : ''}`;
    this.log(`ICE com "${peer.name}": meus candidatos [${fmt(local)}] · dele [${fmt(remote)}]`, 'warn');
    for (const text of errors.values()) this.log(`ICE erro: ${text}`, 'warn');
    let hint = '';
    if (!local.host && !local.srflx) hint = 'Meu aparelho não gerou nenhuma rota (rede bloqueando WebRTC).';
    else if (!remote.host && !remote.srflx) hint = `O aparelho de "${peer.name}" não gerou nenhuma rota: a rede dele bloqueia WebRTC.`;
    else if (!local.srflx || !remote.srflx) hint = 'Um dos lados não descobriu o próprio IP público (STUN bloqueado): só funciona na mesma rede.';
    else hint = 'Os dois lados têm IP público, mas nenhum par funcionou: NAT simétrico/CGNAT dos dois lados.';
    this.log(`Diagnóstico: ${hint} A sala passa para o servidor de mídia se a falha continuar.`, 'warn');
    peer.ice = { local: newIceCount(), remote: newIceCount(), errors: new Map() };
  }

  // One more failed attempt with this person. Returns the ladder step for the next one.
  linkFailed(peerId, name) {
    const f = this.linkFails.get(peerId) || { count: 0, unreachable: false, since: Date.now() };
    f.count++;
    if (!f.unreachable && f.count >= UNREACHABLE_AFTER) {
      f.unreachable = true;
      this.log(`Sem P2P direto com "${name}". Avisando o servidor (a sala passa para o servidor de mídia, se houver um) e tentando de novo a cada ${UNREACHABLE_RETRY_MS / 1000} s.`, 'error');
    }
    this.linkFails.set(peerId, f);
    return f;
  }

  // Initiator side: start over with a new connection. failed: this attempt never worked, so climb
  // the ladder (one more try right away, then "sem conexão" with slow retries). The person stays
  // on screen meanwhile (see ghosts()).
  rebuildPeer(peerId, { failed = false, now = false } = {}) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    const info = { id: peer.id, name: peer.name, avatarUrl: peer.avatarUrl };
    const rebuilds = (peer.rebuilds || 0) + 1;
    this.removePeer(peerId, { keepStream: true });
    if (!this.roster.has(peerId) || !this.activeRoomId) return;
    const f = failed ? this.linkFailed(peerId, info.name) : this.linkFails.get(peerId);
    let delay = Math.min(30000, 1000 * 2 ** Math.min(rebuilds, 5));
    if (f) delay = f.unreachable ? UNREACHABLE_RETRY_MS : 1000;
    if (now) delay = 300;
    const pending = this.linkFails.get(peerId) || { count: 0, unreachable: false, since: Date.now() };
    pending.waiting = true;
    this.linkFails.set(peerId, pending);
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      pending.waiting = false;
      if (this.activeRoomId && this.roster.has(peerId) && !this.peers.has(peerId)) {
        const next = this.connectTo(info);
        if (next) next.rebuilds = rebuilds;
      }
      this.notifyPeersUpdate();
    }, delay);
    this.notifyPeersUpdate();
  }

  // Answering side: the connection never came up. Ask the initiator for a new one (it may be a
  // background tab whose timers barely run) and count the failure like the initiator does.
  responderStuck(peer) {
    const f = this.linkFailed(peer.id, peer.name);
    peer.status = f.unreachable ? 'failed' : 'reconnecting';
    const wait = f.unreachable ? UNREACHABLE_RETRY_MS : RESPONDER_TIMEOUT_MS;
    // checkStuckPeers only steps in if this timer doesn't run (throttled background tab).
    peer.nextCheckAt = Date.now() + wait + 5000;
    this.log(`Conexão com "${peer.name}" não respondeu. Pedindo uma nova...`, 'warn');
    this.logIceDiagnosis(peer);
    this.sendRedial(peer.id, peer.connId);
    // Keep asking while it stays down.
    clearTimeout(peer.timers.connect);
    peer.timers.connect = setTimeout(() => {
      if (this.peers.get(peer.id) === peer && peer.pc.connectionState !== 'connected') this.responderStuck(peer);
    }, wait);
    this.refreshStatus();
    this.notifyPeersUpdate();
  }

  sendRedial(peerId, connId = '') {
    // Only pages that know it (v2 in the roster); older ones would ignore it anyway.
    if (!this.roster.get(peerId)?.v2) return;
    this.sendSignal(peerId, 'redial', { connId: connId || 'none' });
  }

  // The other side asks for a new connection: we are the initiator of this pair.
  handleRedial(fromPeerId, peer) {
    if (this.myPeerId > fromPeerId || !this.roster.has(fromPeerId)) return;
    if (peer) {
      // A connection still young or working is left alone.
      if (peer.pc?.connectionState === 'connected' || Date.now() - peer.createdAt < 10000) return;
      this.log(`"${peer.name}" pediu uma nova conexão.`);
      this.rebuildPeer(fromPeerId, { failed: peer.status !== 'reconnecting', now: true });
      return;
    }
    const pending = this.linkFails.get(fromPeerId);
    if (pending?.waiting) {
      // We were waiting to retry: do it now.
      clearTimeout(pending.timer);
      pending.waiting = false;
    }
    const info = this.roster.get(fromPeerId);
    if (info && !this.peers.has(fromPeerId)) this.connectTo(info);
  }

  // Run on every poll answer, not only by timers: a background tab's timers can be throttled to
  // once a minute, and a responder never got a nudge before. Peers we should dial but don't have
  // (and aren't waiting for) are dialed; a responder whose initiator vanished asks for a call.
  checkStuckPeers() {
    const now = Date.now();
    for (const peer of this.peers.values()) {
      if (peer.virtual || peer.status === 'connected' || peer.pc.connectionState === 'connected') continue;
      if (peer.initiator) {
        // "reconnecting" = it worked before and recoverPeer is on it.
        if (peer.status !== 'reconnecting' && now > peer.createdAt + CONNECT_TIMEOUT_MS + 5000) this.rebuildPeer(peer.id, { failed: true });
      } else if (now > (peer.nextCheckAt || peer.createdAt + RESPONDER_TIMEOUT_MS + 5000)) {
        this.responderStuck(peer);
      }
    }
    for (const [id, info] of this.roster) {
      if (this.peers.has(id) || this.departed.has(id)) continue;
      const f = this.linkFails.get(id);
      if (this.myPeerId < id) {
        if (!f?.waiting) this.connectTo(info);
      } else if (!f || now - (f.askedAt || 0) > (f.unreachable ? UNREACHABLE_RETRY_MS : RESPONDER_TIMEOUT_MS)) {
        // They should dial us and haven't: nudge them (only after the first attempt window).
        const g = f || { count: 0, unreachable: false, since: now };
        g.askedAt = now;
        if (now - g.since > RESPONDER_TIMEOUT_MS) this.sendRedial(id);
        this.linkFails.set(id, g);
      }
    }
  }

  // People in the room with no connection object right now (between attempts, or never dialed):
  // shown anyway, with the state the server has for them.
  ghosts() {
    const list = [];
    for (const [id, info] of this.roster) {
      if (this.peers.has(id)) continue;
      const f = this.linkFails.get(id);
      list.push({ ...info, status: f?.unreachable ? 'failed' : f?.count ? 'reconnecting' : 'connecting', state: info.state || null });
    }
    return list;
  }

  removePeer(peerId, { keepStream = false } = {}) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.peers.delete(peerId);
    for (const timer of Object.values(peer.timers)) clearTimeout(timer);
    peer.pc.onnegotiationneeded = null;
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    try { peer.dc?.close(); } catch { /* already closed */ }
    try { peer.directFileDc?.close(); } catch { /* already closed */ }
    try { peer.pc.close(); } catch { /* already closed */ }
    for (const key of this.orphanedCandidates.keys()) {
      if (key.startsWith(`${peerId}:`)) this.orphanedCandidates.delete(key);
    }
    if (!keepStream) {
      this.watching.delete(peerId);
      this.onPeerStreamEnded(peerId, 'all');
      const f = this.linkFails.get(peerId);
      clearTimeout(f?.timer);
      this.linkFails.delete(peerId);
    }
    this.refreshStatus();
    this.notifyPeersUpdate();
  }

  // --- DATA CHANNEL ---

  setupDataChannel(peer, channel) {
    peer.dc = channel;
    channel.onopen = () => {
      // Capabilities for new features (see docs/webrtc-regras.md, rule 2). No relayLink: the
      // chat-media TURN link is gone, so older pages never try to open one with us.
      // handoff: when the room moves P2P -> SFU we keep this connection until both sides see each
      // other through the media server (see sfu-engine.js, sfuHandoffCheck).
      this.sendTo(peer, { type: 'caps', handoff: true });
      this.sendTo(peer, { type: 'screen_status', streaming: !!this.localStream, hasAudio: !!this.localStream?.getAudioTracks().length });
      this.sendTo(peer, this.voiceState());
      this.sendTo(peer, { type: 'watching', ids: [...this.watching] });
      if (this.localStream) setTimeout(() => this.sendPreview(peer), 800);
    };
    channel.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'caps') {
        peer.canHandoff = !!msg.handoff;
        return;
      }
      if (msg.type === 'handoff_ready') {
        peer.handoffPeerReady = true;
        this.meshHandoffReady(peer);
        return;
      }
      // P2P -> SFU handoff: this old connection still carries their messages until it closes, but
      // the person on screen is already the media-server one (peer.handoffTo).
      const to = this.handoffTarget(peer);
      if (msg.type === 'ping') {
        this.sendTo(peer, { type: 'pong', timestamp: msg.timestamp });
      } else if (msg.type === 'pong') {
        if (typeof msg.timestamp === 'number') to.stats.pingMs = Math.max(1, Math.round(performance.now() - msg.timestamp));
      } else if (msg.type === 'voice_state') {
        this.applyVoiceState(to, msg);
      } else if (msg.type === 'screen_status') {
        this.applyScreenStatus(to, !!msg.streaming);
      } else if (msg.type === 'watching') {
        this.applyWatching(to, msg.ids);
      } else if (msg.type === 'preview') {
        const image = msg.image;
        if (to.isStreaming && typeof image === 'string' && image.length < 400_000 && image.startsWith('data:image/jpeg;base64,')) {
          to.preview = image;
          this.notifyPeersUpdate();
        }
      } else if (msg.type === 'bye') {
        this.markDeparted(to.id);
        this.removePeer(to.id);
      } else {
        this.onPeerMessage({ fromPeerId: to.id, fromName: to.name, message: msg });
      }
    };
  }

  // P2P -> SFU handoff hooks (see sfu-engine.js): the peer that should get messages arriving on an
  // old P2P channel, and the other side saying it sees us through the media server.
  handoffTarget(peer) {
    const next = peer.handoffTo;
    return next && this.peers.get(peer.id) === next ? next : peer;
  }

  meshHandoffReady() {}

  applyVoiceState(peer, msg) {
    peer.micMuted = !!msg.micMuted;
    peer.deafened = !!msg.deafened;
    peer.speaking = !!msg.speaking && !peer.micMuted;
    peer.cameraOn = !!msg.camera && !!peer.cameraStream;
    this.onVoiceStateChange(peer.id);
  }

  applyScreenStatus(peer, streaming) {
    const was = peer.isStreaming;
    peer.statusFromChannel = true;
    peer.isStreaming = streaming;
    if (peer.isStreaming && !was) {
      this.log(`"${peer.name}" começou a transmitir.`, 'success');
      this.onPeerStream(peer.id, peer.remoteStream, peer.remoteStream.getVideoTracks()[0], peer);
    } else if (!peer.isStreaming && was) {
      this.log(`"${peer.name}" parou de transmitir.`);
      peer.preview = null;
      // Watching ends with the stream; the next one starts unwatched again.
      if (this.watching.delete(peer.id)) this.broadcastWatching();
      this.onPeerStreamEnded(peer.id, 'video');
    }
    this.notifyPeersUpdate();
  }

  applyWatching(peer, list) {
    const ids = Array.isArray(list) ? list.filter(id => typeof id === 'string').slice(0, 32) : [];
    const was = this.isWatchedBy(peer);
    peer.watching = new Set(ids);
    const now = this.isWatchedBy(peer);
    if (this.localStream && was !== now) {
      if (now) this.log(`"${peer.name}" está assistindo.`);
      this.attachLocalTracks(peer);
      // Fewer or more viewers changes the bitrate each one gets.
      for (const other of this.peers.values()) if (other !== peer && this.isWatchedBy(other)) this.applyVideoEncoding(other);
      if (!now) this.sendPreview(peer);
    }
    this.notifyPeersUpdate();
  }

  // The server's copy of a person's state (see localState), used while there's no channel to them.
  // Only real changes are applied, so the same copy every poll doesn't spam the log. It is checked
  // every time (not only when its version changes): a video track that "unmutes" without a working
  // connection used to mark people as streaming, and the server's copy has to correct that.
  applyServerState(peer, state) {
    if (!state) return;
    // From here on the server, not the track heuristic in handleRemoteTrack, says who streams.
    peer.statusFromChannel = true;
    if (peer.micMuted !== !!state.m || peer.deafened !== !!state.d) {
      this.applyVoiceState(peer, { micMuted: !!state.m, deafened: !!state.d, speaking: false, camera: !!state.c });
    }
    if (peer.isStreaming !== !!state.s) this.applyScreenStatus(peer, !!state.s);
    const ids = Array.isArray(state.w) ? state.w : [];
    if (ids.join(',') !== [...peer.watching].join(',')) this.applyWatching(peer, ids);
  }

  sendTo(peer, message) {
    try {
      if (peer.dc?.readyState === 'open') peer.dc.send(JSON.stringify(message));
    } catch { /* closing */ }
  }

  broadcast(message) {
    for (const peer of this.peers.values()) this.sendTo(peer, message);
  }

  // --- WATCHING ---

  setWatching(peerId, on) {
    if (on) this.watching.add(peerId);
    else this.watching.delete(peerId);
    this.broadcastWatching();
    this.notifyPeersUpdate();
  }

  broadcastWatching() {
    this.broadcast({ type: 'watching', ids: [...this.watching] });
  }

  // Peers that don't watch our stream get a still frame now and then, for the card.
  startPreviews() {
    this.stopPreviews();
    const tick = () => {
      for (const peer of this.peers.values()) {
        if (!this.isWatchedBy(peer)) this.sendPreview(peer);
      }
    };
    // One frame right away (so the card isn't empty), then only every 5 minutes.
    this.previewTimers = [setTimeout(tick, 1200), setInterval(tick, 5 * 60 * 1000)];
  }

  stopPreviews() {
    for (const timer of this.previewTimers) clearTimeout(timer);
    this.previewTimers = [];
    this.previewCache = null;
    if (this.previewVideo) this.previewVideo.srcObject = null;
  }

  async capturePreview() {
    const track = this.localStream?.getVideoTracks()[0];
    if (!track || track.readyState !== 'live' || this.capturePaused) return null;
    if (this.previewCache?.track === track && Date.now() - this.previewCache.time < 3000) return this.previewCache.image;
    if (!this.previewVideo) {
      this.previewVideo = document.createElement('video');
      this.previewVideo.muted = true;
      this.previewVideo.playsInline = true;
    }
    const video = this.previewVideo;
    if (video.srcObject?.getVideoTracks()[0] !== track) {
      video.srcObject = new MediaStream([track]);
      await video.play().catch(() => {});
      for (let i = 0; i < 20 && !video.videoWidth; i++) await sleep(50);
    }
    if (!video.videoWidth || !video.videoHeight) return null;
    const canvas = this.previewCanvas || (this.previewCanvas = document.createElement('canvas'));
    canvas.width = 480;
    canvas.height = Math.max(1, Math.min(480, Math.round(480 * video.videoHeight / video.videoWidth)));
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = canvas.toDataURL('image/jpeg', 0.72);
    this.previewCache = { track, time: Date.now(), image };
    return image;
  }

  async sendPreview(peer, tries = 0) {
    const image = await this.capturePreview().catch(() => null);
    // Right after going live the capture may not have a frame yet: try again shortly, or the
    // card would stay empty until the next round (5 min).
    if (!image && this.localStream && tries < 4) {
      setTimeout(() => {
        if (this.peers.get(peer.id) === peer) this.sendPreview(peer, tries + 1);
      }, 1500);
      return;
    }
    if (image && this.localStream && !this.isWatchedBy(peer)) this.sendTo(peer, { type: 'preview', image });
  }

  // --- SCREEN SHARING ---

  // Opens the picker (the browser's, or the desktop app's own one with quality settings) and
  // returns the new capture, its audio already attached. Does not touch the current share.
  async captureDisplay({ beforeAudio } = {}) {
    if (!window.isSecureContext) throw new Error('O compartilhamento de tela exige HTTPS.');
    const getDisplayMedia = displayMediaFn();
    if (!getDisplayMedia) throw screenShareUnsupported();
    const desktop = window.kscreenDesktop?.share;
    // A new pick starts unpaused; the app re-sends the state if it watches a game window.
    this.captureHidden = false;
    // Desktop app: its picker shows (and can change) resolution/FPS before going live.
    desktop?.prepare?.({ ...this.shareSettings, audio: this.shareAudioEnabled });

    this.log('Solicitando captura de tela...');
    const stream = await requestDisplayMedia(getDisplayMedia, [
      {
        video: this.videoConstraints(),
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 }, sampleRate: { ideal: 48000 } },
        // Chrome: offer the "share system audio" checkbox for whole-screen captures too.
        systemAudio: 'include'
      },
      // Older and mobile browsers reject what they don't know (audio, constraints): ask for less.
      { video: true, audio: true },
      { video: true }
    ]);

    const picked = await desktop?.result?.().catch(() => null);
    if (picked) {
      // Older app versions don't send the audio quality: keep ours.
      this.shareSettings = validShareSettings({ ...this.shareSettings, ...picked });
      this.onShareSettingsChange(this.shareSettings);
    }
    const [videoTrack] = stream.getVideoTracks();
    if (videoTrack) {
      try { videoTrack.contentHint = 'motion'; } catch { /* optional */ }
      if (picked) await videoTrack.applyConstraints(this.videoConstraints()).catch(() => {});
    }
    // The desktop app's PC-audio capture is one at a time: release the old one first.
    beforeAudio?.();
    if (!stream.getAudioTracks().length) await this.attachDesktopSystemAudio(stream);
    return stream;
  }

  async startScreenShare() {
    if (this.localStream) return this.localStream;
    const stream = await this.captureDisplay();
    // A new share always starts with its audio on.
    this.shareAudioEnabled = true;
    this.goLive(stream);
    this.log('Compartilhamento de tela iniciado.', 'success');
    return stream;
  }

  // "Alterar a transmissão": pick another window/screen without ending the live.
  async switchScreenShare() {
    if (!this.localStream) return this.startScreenShare();
    const old = this.localStream;
    const stream = await this.captureDisplay({ beforeAudio: () => this.stopDesktopSystemAudio() });
    for (const track of old.getTracks()) {
      track.onended = null;
      track.stop();
    }
    this.goLive(stream);
    this.log('Fonte da transmissão alterada.', 'success');
    return stream;
  }

  setCapturePaused(paused) {
    this.captureHidden = !!paused;
    this.capturePaused = this.captureHidden && !!this.localStream;
    const track = this.localStream?.getVideoTracks()[0];
    if (track) track.enabled = !this.capturePaused; // disabled video tracks send black frames
    this.onCapturePaused(this.capturePaused);
  }

  goLive(stream) {
    const [videoTrack] = stream.getVideoTracks();
    if (videoTrack) {
      videoTrack.onended = () => {
        if (this.localStream === stream) this.stopScreenShare();
      };
    }
    this.localStream = stream;
    this.applyShareAudioEnabled();
    this.setCapturePaused(this.captureHidden);
    for (const peer of this.peers.values()) {
      this.attachLocalTracks(peer);
      if (peer.status === 'connected') this.applyVideoEncoding(peer);
    }
    this.broadcast({ type: 'screen_status', streaming: true, hasAudio: stream.getAudioTracks().length > 0 });
    this.startPreviews();
    this.onLocalStream(stream);
    this.notifyPeersUpdate();
  }

  // "Compartilhar áudio da transmissão": off sends silence, no renegotiation.
  setShareAudioEnabled(on) {
    this.shareAudioEnabled = !!on;
    this.applyShareAudioEnabled();
    return this.shareAudioEnabled;
  }

  applyShareAudioEnabled() {
    for (const track of this.localStream?.getAudioTracks() || []) track.enabled = this.shareAudioEnabled;
  }

  hasShareAudio() {
    return !!this.localStream?.getAudioTracks().length;
  }

  // kScreen desktop app: the PC's audio arrives as PCM from a native capture that leaves out the
  // app itself (so friends never hear their own voices back) and becomes a normal audio track.
  async attachDesktopSystemAudio(stream) {
    const bridge = window.kscreenDesktop?.systemAudio;
    if (!bridge) return;
    let ctx = null;
    try {
      ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      await ctx.audioWorklet.addModule('/desktop-audio-worklet.js');
      const node = new AudioWorkletNode(ctx, 'kscreen-pcm-player', {
        numberOfInputs: 0,
        outputChannelCount: [2],
        processorOptions: { channels: 2 }
      });
      const dest = ctx.createMediaStreamDestination();
      dest.channelCount = 2;
      node.connect(dest);
      const format = await bridge.start({
        data: (chunk) => {
          // Copy into a fresh buffer we can transfer to the audio thread.
          const copy = new Uint8Array(chunk.byteLength);
          copy.set(chunk);
          node.port.postMessage(copy.buffer, [copy.buffer]);
        },
        ended: () => this.log('A captura de áudio do PC parou.', 'warn')
      });
      if (!format) {
        await ctx.close();
        return;
      }
      await ctx.resume();
      const [track] = dest.stream.getAudioTracks();
      stream.addTrack(track);
      this.desktopAudio = { ctx, stop: () => bridge.stop() };
      this.log('Áudio do PC capturado.', 'success');
    } catch (err) {
      this.log(`Não foi possível capturar o áudio do PC: ${err.message}`, 'warn');
      try { bridge.stop(); } catch { /* ignore */ }
      ctx?.close().catch(() => {});
    }
  }

  stopDesktopSystemAudio() {
    const audio = this.desktopAudio;
    if (!audio) return;
    this.desktopAudio = null;
    try { audio.stop(); } catch { /* app closing */ }
    audio.ctx.close().catch(() => {});
  }

  stopScreenShare() {
    const stream = this.localStream;
    if (!stream) return;
    this.localStream = null;
    this.capturePaused = false;
    window.kscreenDesktop?.share?.ended?.();
    this.stopDesktopSystemAudio();
    this.stopPreviews();
    for (const track of stream.getTracks()) {
      track.onended = null;
      track.stop();
    }
    for (const peer of this.peers.values()) this.attachLocalTracks(peer);
    this.broadcast({ type: 'screen_status', streaming: false });
    this.onScreenShareEnded();
    this.log('Compartilhamento de tela encerrado.');
    this.notifyPeersUpdate();
  }

  // --- MICROPHONE ---

  // Returns the new muted state. The mic is only captured on first unmute.
  async toggleMute() {
    // Once the user unmutes, the mic is theirs: Instant Replay no longer closes it.
    this.micOpenedMuted = false;
    if (!this.micStream) {
      await this.openMic();
      this.isMicMuted = false;
      for (const peer of this.peers.values()) this.attachLocalTracks(peer);
      this.startSpeakingDetector();
      this.log('Microfone ativado.', 'success');
      this.broadcastVoiceState();
      return this.isMicMuted;
    }
    this.isMicMuted = !this.isMicMuted;
    for (const track of this.micStream.getAudioTracks()) track.enabled = !this.isMicMuted;
    this.broadcastVoiceState();
    return this.isMicMuted;
  }

  // Opens the mic WITHOUT unmuting (Instant Replay's "record the mic even muted"). Peers get the
  // track already off (silence, as before), so a later unmute is the usual on/off.
  async openMicMuted() {
    if (this.micStream) return this.micStream;
    await this.openMic();
    for (const track of this.micStream.getAudioTracks()) track.enabled = false;
    this.isMicMuted = true;
    this.micOpenedMuted = true;
    for (const peer of this.peers.values()) this.attachLocalTracks(peer);
    this.startSpeakingDetector();
    return this.micStream;
  }

  // Closes a mic that openMicMuted opened, if the user never unmuted it (Instant Replay stopped
  // or its "even muted" option was turned off). Returns whether it was closed.
  releaseMutedMic() {
    if (!this.micOpenedMuted || !this.micStream || !this.isMicMuted) return false;
    this.micOpenedMuted = false;
    this.stopMic();
    for (const peer of this.peers.values()) this.attachLocalTracks(peer);
    return true;
  }

  // The mic goes through a gain node (input volume). Peers get the gain's output track, which
  // stays the same when the device changes, so switching mics needs no renegotiation.
  async captureMicRaw() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microfone indisponível neste navegador.');
    const id = this.micDeviceId && this.micDeviceId !== 'default' ? this.micDeviceId : null;
    return navigator.mediaDevices.getUserMedia({
      audio: {
        ...(id ? { deviceId: { exact: id } } : {}),
        echoCancellation: this.echoCancellation,
        // Our RNNoise does the noise suppression; stacking the browser's on top muffles voices.
        noiseSuppression: this.noiseSuppression && this.noiseFallback,
        autoGainControl: true
      }
    });
  }

  async openMic() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    // 48 kHz: RNNoise only works at that rate (the browser resamples the mic if needed).
    const ctx = new AudioContextClass({ sampleRate: 48000 });
    const gain = ctx.createGain();
    gain.gain.value = this.micVolume / 100;
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 1;
    gain.connect(dest);
    // Voice detection taps the raw mic (before the input volume) through these:
    // - the RNNoise node, which also reports voice activity; when suppression is off it is
    //   kept out of the audio path and its output goes to a silent sink so it still runs;
    // - an analyser for the fallback detector (RNNoise unavailable).
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    ctx.resume().catch(() => {});
    this.mic = { ctx, gain, dest, sink, analyser, raw: null, source: null, noise: null };
    await this.ensureNoiseNode();
    this.plugMicRaw(await this.captureMicRaw());
    this.micStream = dest.stream;
  }

  // Creates the RNNoise node once per mic context. On failure (old browser, blocked download)
  // the browser's own noise suppression takes over.
  async ensureNoiseNode() {
    const mic = this.mic;
    if (!mic || mic.noise || this.noiseFallback) return mic?.noise || null;
    try {
      const [bytes] = await Promise.all([loadRnnoise(), mic.ctx.audioWorklet.addModule(noiseWorkletUrl)]);
      if (this.mic !== mic) return null;
      mic.noise = new AudioWorkletNode(mic.ctx, 'kscreen-noise-suppressor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { wasm: bytes, strength: this.noiseStrength / 100 }
      });
      mic.noise.port.onmessage = (e) => {
        if (typeof e.data?.speaking === 'boolean') this.voiceActivity = e.data.speaking;
      };
      return mic.noise;
    } catch (err) {
      console.warn('Supressor de ruído indisponível, usando o do navegador:', err);
      this.log('Supressor de ruído indisponível. Usando o do navegador.', 'warn');
      this.noiseFallback = true;
      return null;
    }
  }

  // mic -> [noise suppressor] -> input volume -> what peers receive
  // The RNNoise node always listens to the raw mic (voice detection); it only sits in the
  // audio path while noise suppression is on.
  routeMic() {
    const mic = this.mic;
    if (!mic?.source) return;
    try { mic.source.disconnect(); } catch { /* not connected */ }
    try { mic.noise?.disconnect(); } catch { /* not connected */ }
    mic.source.connect(mic.analyser);
    if (mic.noise) mic.source.connect(mic.noise);
    if (this.noiseSuppression && mic.noise) {
      mic.noise.connect(mic.gain);
    } else {
      mic.source.connect(mic.gain);
      mic.noise?.connect(mic.sink);
    }
  }

  // Applies the voice menu's settings. Echo cancellation (and the fallback suppressor) are
  // capture options, so changing them re-opens the mic; the RNNoise part switches live.
  async setMicProcessing({ noiseSuppression, noiseStrength, echoCancellation } = {}) {
    const before = { ns: this.noiseSuppression && this.noiseFallback, ec: this.echoCancellation };
    if (noiseSuppression !== undefined) this.noiseSuppression = !!noiseSuppression;
    if (noiseStrength !== undefined) this.noiseStrength = Math.max(0, Math.min(100, Number(noiseStrength) || 0));
    if (echoCancellation !== undefined) this.echoCancellation = !!echoCancellation;
    const mic = this.mic;
    if (!mic) return;
    await this.ensureNoiseNode();
    if (this.mic !== mic) return;
    mic.noise?.port.postMessage({ strength: this.noiseStrength / 100 });
    const after = { ns: this.noiseSuppression && this.noiseFallback, ec: this.echoCancellation };
    if (before.ns !== after.ns || before.ec !== after.ec) this.plugMicRaw(await this.captureMicRaw());
    else this.routeMic();
  }

  plugMicRaw(raw) {
    const mic = this.mic;
    if (mic.raw) {
      try { mic.source.disconnect(); } catch { /* not connected */ }
      for (const track of mic.raw.getTracks()) { track.onended = null; track.stop(); }
    }
    mic.raw = raw;
    mic.source = mic.ctx.createMediaStreamSource(raw);
    this.routeMic();
    const [track] = raw.getAudioTracks();
    track.onended = () => {
      if (this.mic?.raw !== raw) return;
      this.stopMic();
      for (const peer of this.peers.values()) this.attachLocalTracks(peer);
      this.broadcastVoiceState();
      this.notifyPeersUpdate();
    };
  }

  async setMicDevice(id) {
    this.micDeviceId = id || 'default';
    if (this.mic) this.plugMicRaw(await this.captureMicRaw());
  }

  setMicVolume(volume) {
    this.micVolume = Math.max(0, Math.min(200, Number(volume) || 0));
    if (this.mic) this.mic.gain.gain.value = this.micVolume / 100;
  }

  // Settings > "Teste do microfone": the same chain the others hear (device, echo cancellation,
  // RNNoise at the current strength, input volume), played back on `sinkId`. Separate from the
  // call's mic, so it works outside a room too. Returns the analyser and a close().
  async openMicTest({ sinkId = '', outputVolume = 100 } = {}) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioContextClass({ sampleRate: 48000 }); // RNNoise needs 48 kHz
    let raw = null;
    let noise = null;
    const close = () => {
      for (const track of raw?.getTracks() || []) track.stop();
      noise?.port.postMessage({ destroy: true });
      ctx.close().catch(() => {});
    };
    try {
      if (sinkId && ctx.setSinkId) await ctx.setSinkId(sinkId).catch(() => {});
      raw = await this.captureMicRaw();
      const source = ctx.createMediaStreamSource(raw);
      const gain = ctx.createGain();
      gain.gain.value = this.micVolume / 100;
      if (this.noiseSuppression && !this.noiseFallback) {
        try {
          const [bytes] = await Promise.all([loadRnnoise(), ctx.audioWorklet.addModule(noiseWorkletUrl)]);
          noise = new AudioWorkletNode(ctx, 'kscreen-noise-suppressor', {
            numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
            processorOptions: { wasm: bytes, strength: this.noiseStrength / 100 }
          });
        } catch { noise = null; }
      }
      if (noise) source.connect(noise).connect(gain);
      else source.connect(gain);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      const out = ctx.createGain();
      out.gain.value = outputVolume / 100;
      gain.connect(analyser);
      gain.connect(out).connect(ctx.destination);
      await ctx.resume().catch(() => {});
      return {
        analyser,
        suppressed: !!noise || (this.noiseSuppression && this.noiseFallback),
        setMicVolume: (v) => { gain.gain.value = v / 100; },
        setOutputVolume: (v) => { out.gain.value = v / 100; },
        setStrength: (v) => noise?.port.postMessage({ strength: v / 100 }),
        close
      };
    } catch (err) {
      close();
      throw err;
    }
  }

  // --- CAMERA ---

  async captureCamera() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Câmera indisponível neste navegador.');
    const id = this.cameraDeviceId && this.cameraDeviceId !== 'default' ? this.cameraDeviceId : null;
    return navigator.mediaDevices.getUserMedia({
      video: { ...(id ? { deviceId: { exact: id } } : {}), width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } }
    });
  }

  // Switches the camera; if it is on, the new one replaces it right away.
  async setCameraDevice(id) {
    this.cameraDeviceId = id || 'default';
    if (!this.cameraStream) return;
    const stream = await this.captureCamera();
    const old = this.cameraStream;
    this.useCameraStream(stream);
    for (const track of old.getTracks()) { track.onended = null; track.stop(); }
  }

  useCameraStream(stream) {
    const [track] = stream.getVideoTracks();
    try { track.contentHint = 'motion'; } catch { /* optional */ }
    track.onended = () => {
      if (this.cameraStream === stream) this.stopCamera();
    };
    this.cameraStream = stream;
    for (const peer of this.peers.values()) this.attachLocalTracks(peer);
    this.notifyPeersUpdate();
  }

  // Returns whether the camera is now on. Turning it off releases the device (camera light goes off).
  async toggleCamera() {
    if (this.cameraStream) {
      this.stopCamera();
      return false;
    }
    const stream = await this.captureCamera();
    this.useCameraStream(stream);
    this.log('Câmera ligada.', 'success');
    this.broadcastVoiceState();
    return true;
  }

  stopCamera() {
    const stream = this.cameraStream;
    if (!stream) return;
    this.cameraStream = null;
    for (const track of stream.getTracks()) {
      track.onended = null;
      track.stop();
    }
    for (const peer of this.peers.values()) this.attachLocalTracks(peer);
    this.log('Câmera desligada.');
    this.broadcastVoiceState();
  }

  setDeafened(deafened) {
    this.isDeafened = !!deafened;
    this.broadcastVoiceState();
  }

  voiceState() {
    return { type: 'voice_state', micMuted: this.isMicMuted, deafened: this.isDeafened, speaking: this.isSpeaking, camera: !!this.cameraStream };
  }

  broadcastVoiceState() {
    if (this.isMicMuted) this.isSpeaking = false;
    this.broadcast(this.voiceState());
    this.onVoiceStateChange('local');
  }

  // Each client detects its OWN voice and tells the others, so the "speaking" ring
  // works even where the listener's audio is still blocked by autoplay rules.
  //
  // Like Discord, it looks for a VOICE, not for a volume above a fixed line (which missed
  // quiet voices and quiet mics): RNNoise's voice-activity estimate, measured on the raw mic so
  // the input volume doesn't matter (see noise-worklet.js). Without RNNoise, a level detector
  // that follows each person's background noise takes over: speech is whatever stands clearly
  // above their own noise floor.
  startSpeakingDetector() {
    this.stopSpeakingDetector();
    const mic = this.mic;
    if (!mic) return;
    const samples = new Float32Array(mic.analyser.fftSize);
    // Background noise of this mic: the quiet end (10th percentile) of the last 3 s of readings.
    const history = new Float32Array(60).fill(-100);
    let historyIndex = 0;
    let lastVoice = 0;
    const timer = setInterval(() => {
      if (this.mic !== mic) return;
      if (mic.ctx.state === 'suspended') mic.ctx.resume().catch(() => {});
      // Muted means silent, whatever else touched the track (LiveKit re-enables tracks it wraps).
      for (const track of this.micStream?.getAudioTracks() || []) {
        if (track.enabled === this.isMicMuted) {
          track.enabled = !this.isMicMuted;
          if (this.isMicMuted) this.log('Microfone religado por fora enquanto mutado; silenciado de novo.', 'warn');
        }
      }
      let voice;
      if (mic.noise) {
        voice = this.voiceActivity;
      } else {
        mic.analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const value of samples) sum += value * value;
        const db = 10 * Math.log10(sum / samples.length + 1e-12);
        history[historyIndex] = db;
        historyIndex = (historyIndex + 1) % history.length;
        const floor = Float32Array.from(history).sort()[6];
        // Speech stands clearly above that background (speech has pauses, so the background
        // estimate stays on the noise, not on the voice).
        if (db > Math.max(floor + 8, -72)) lastVoice = performance.now();
        voice = performance.now() - lastVoice < 300;
      }
      const speaking = !this.isMicMuted && !!voice;
      if (speaking !== this.isSpeaking) {
        this.isSpeaking = speaking;
        this.broadcastVoiceState();
      }
    }, 50);
    this.speakingDetector = { timer };
  }

  stopSpeakingDetector() {
    if (!this.speakingDetector) return;
    clearInterval(this.speakingDetector.timer);
    this.speakingDetector = null;
    this.isSpeaking = false;
    this.voiceActivity = false;
  }

  stopMic() {
    if (!this.micStream) return;
    for (const stream of [this.micStream, this.mic?.raw]) {
      for (const track of stream?.getTracks() || []) {
        track.onended = null;
        track.stop();
      }
    }
    this.mic?.noise?.port.postMessage({ destroy: true });
    this.mic?.ctx.close().catch(() => {});
    this.mic = null;
    this.micStream = null;
    this.isMicMuted = true;
    this.micOpenedMuted = false;
    this.stopSpeakingDetector();
  }

  restartIce() {
    for (const peer of this.peers.values()) {
      peer.iceRestarts = 0;
      try { peer.pc.restartIce(); } catch { /* closed */ }
    }
    this.log('Renovando rotas ICE com todos os participantes...');
  }

  // --- TELEMETRY ---

  startStatsMonitoring() {
    this.stopStatsMonitoring();

    this.pingInterval = setInterval(() => {
      this.broadcast({ type: 'ping', timestamp: performance.now() });
    }, 2000);

    this.statsInterval = setInterval(async () => {
      for (const peer of this.peers.values()) {
        if (!peer.pc || peer.pc.connectionState !== 'connected') continue;
        try {
          const report = await peer.pc.getStats();
          let pair = null;
          report.forEach(item => {
            if (item.type === 'transport' && item.selectedCandidatePairId) pair = report.get(item.selectedCandidatePairId);
          });
          if (!pair) {
            report.forEach(item => {
              if (item.type === 'candidate-pair' && item.nominated && item.state === 'succeeded') pair = item;
            });
          }
          if (!pair) continue;
          const local = report.get(pair.localCandidateId) || {};
          const remote = report.get(pair.remoteCandidateId) || {};
          const address = `${local.address || local.ip || ''}${remote.address || remote.ip || ''}`;
          const isIpv6 = address.includes(':');
          // relayProtocol only exists on candidates allocated on a TURN server. Chrome can report
          // such a candidate as "prflx" (when a check found that address before the relay
          // candidate was gathered), so candidateType alone misses connections that do go
          // through the TURN.
          const isRelay = local.candidateType === 'relay' || remote.candidateType === 'relay' || !!local.relayProtocol;
          const isLan = local.candidateType === 'host' && remote.candidateType === 'host';

          let connectionShort = isIpv6 ? 'P2P IPv6' : 'P2P IPv4';
          let connectionName = 'P2P direto (STUN)';
          if (isRelay) {
            connectionShort = 'Relay TURN';
            connectionName = 'Via servidor TURN';
          } else if (isLan) {
            connectionShort = 'Rede local';
            connectionName = 'P2P direto na rede local';
          } else if (isIpv6) {
            connectionName = 'P2P direto (IPv6)';
          }

          peer.stats = {
            ...peer.stats,
            routeKnown: true,
            rttMs: typeof pair.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : peer.stats.rttMs,
            isIpv6,
            isRelay,
            connectionShort,
            connectionName,
            protocol: (local.protocol || 'udp').toUpperCase(),
            // What is actually flowing, to tell bandwidth ramp-up apart from CPU/network limits
            sending: this.localStream ? this.videoFlow(report, 'outbound-rtp', peer.stats.sending) : null,
            receiving: peer.isStreaming ? this.videoFlow(report, 'inbound-rtp', peer.stats.receiving) : null
          };
          this.checkVideoHealth(peer);
        } catch { /* closed during getStats */ }
      }
      this.notifyPeersUpdate();
    }, 2000);
  }

  stopStatsMonitoring() {
    clearInterval(this.pingInterval);
    clearInterval(this.statsInterval);
    this.pingInterval = null;
    this.statsInterval = null;
  }

  videoFlow(report, type, previous) {
    let rtp = null;
    // Several video streams can exist (camera, simulcast layers): the one carrying the most is
    // the screen.
    const bytesOf = (item) => (type === 'outbound-rtp' ? item.bytesSent : item.bytesReceived) || 0;
    report.forEach(item => {
      if (item.type === type && (item.kind ?? item.mediaType) === 'video' && (!rtp || bytesOf(item) > bytesOf(rtp))) rtp = item;
    });
    if (!rtp) return null;
    const bytes = type === 'outbound-rtp' ? rtp.bytesSent : rtp.bytesReceived;
    const kbps = previous && bytes >= previous.bytes && rtp.timestamp > previous.time
      ? Math.round((bytes - previous.bytes) * 8 / (rtp.timestamp - previous.time))
      : null;
    return {
      bytes,
      time: rtp.timestamp,
      kbps,
      width: rtp.frameWidth || null,
      height: rtp.frameHeight || null,
      fps: typeof rtp.framesPerSecond === 'number' ? Math.round(rtp.framesPerSecond) : null,
      // "bandwidth" | "cpu" | "none" (sender only)
      limitation: rtp.qualityLimitationReason || null,
      // Receiver only: frames that arrived vs. frames the decoder turned into images. Arriving
      // but not decoded = black screen with the network fine (see checkVideoHealth).
      framesReceived: rtp.framesReceived ?? null,
      framesDecoded: rtp.framesDecoded ?? null,
      keyFramesDecoded: rtp.keyFramesDecoded ?? null,
      decoder: rtp.decoderImplementation || rtp.encoderImplementation || null,
      codec: report.get?.(rtp.codecId)?.mimeType?.replace(/^video\//i, '') || null
    };
  }

  // Black screen while watching: frames reach us but the decoder shows none, or nothing was ever
  // decoded. Happened with H.264 at high resolutions (480p fixed it: a fresh stream). Logs why
  // and asks for a fresh stream (new keyframe); see healVideo.
  checkVideoHealth(peer) {
    const flow = peer.stats?.receiving;
    const health = peer.videoHealth ||= { since: 0, tries: 0, lastReceived: null, lastDecoded: null, watchedAt: 0, okSince: 0 };
    if (!this.watching.has(peer.id) || !peer.isStreaming || peer.status !== 'connected' || !flow || flow.framesDecoded == null) {
      Object.assign(health, { since: 0, lastReceived: null, lastDecoded: null, watchedAt: 0 });
      return;
    }
    const now = Date.now();
    health.watchedAt ||= now;
    const received = flow.framesReceived ?? 0;
    const decoded = flow.framesDecoded;
    const newReceived = health.lastReceived == null ? 0 : received - health.lastReceived;
    const newDecoded = health.lastDecoded == null ? 0 : decoded - health.lastDecoded;
    health.lastReceived = received;
    health.lastDecoded = decoded;
    // Frames arriving but none decoded, or watching for a while and never a single frame.
    const stuck = (newReceived > 0 && newDecoded === 0) || (decoded === 0 && now - health.watchedAt > 6000);
    if (!stuck) {
      health.since = 0;
      if (newDecoded > 0) {
        health.okSince ||= now;
        if (now - health.okSince > 30000) health.tries = 0;
      }
      return;
    }
    health.okSince = 0;
    health.since ||= now;
    if (now - health.since < 4000) return;
    health.since = now;
    health.tries++;
    const what = newReceived > 0 ? `chegam ${newReceived} quadros mas nenhum é decodificado` : 'nenhum quadro chegou';
    this.log(`Tela preta na transmissão de "${peer.name}": ${what} (${flow.codec || '?'} ${flow.width || '?'}×${flow.height || '?'}, decodificador ${flow.decoder || '?'}, ${flow.kbps ?? '?'} kbps). Recuperando (${health.tries})...`, 'warn');
    this.healVideo(peer, health.tries);
  }

  // Mesh: stop and resume watching, so the sender restarts the stream with a keyframe.
  healVideo(peer) {
    if (!this.watching.has(peer.id)) return;
    this.watching.delete(peer.id);
    this.broadcastWatching();
    setTimeout(() => {
      if (this.peers.get(peer.id) !== peer || !peer.isStreaming) return;
      this.watching.add(peer.id);
      this.broadcastWatching();
      this.notifyPeersUpdate();
    }, 800);
  }

  // The route each connection actually uses (from the selected ICE pair), sent with the poll so
  // the admin panel can say P2P or TURN for every room: "p_abc.p,p_def.t" (p = P2P, t = TURN).
  // Only the browser knows this; the TURN server also sees relays that are merely reserved.
  routeReport() {
    const parts = [];
    for (const peer of this.peers.values()) {
      if (peer.pc?.connectionState === 'connected' && peer.stats.routeKnown) parts.push(`${peer.id}.${peer.stats.isRelay ? 't' : 'p'}`);
    }
    return parts.join(',');
  }

  getPeersSummary() {
    return [...this.peers.values()].map(p => ({
      id: p.id,
      name: p.name,
      avatarUrl: p.avatarUrl,
      status: p.status,
      isStreaming: p.isStreaming,
      pingMs: p.stats.pingMs || p.stats.rttMs,
      isIpv6: p.stats.isIpv6,
      isRelay: p.stats.isRelay,
      // How this connection travels: P2P direct, TURN relay or the media server (SFU).
      route: p.virtual ? 'SFU' : p.stats.isRelay ? 'TURN' : 'P2P',
      connectionShort: p.stats.connectionShort,
      connectionName: p.stats.connectionName,
      protocol: p.stats.protocol,
      sending: p.stats.sending || null,
      receiving: p.stats.receiving || null
    }));
  }

  notifyPeersUpdate() {
    this.onPeersUpdate(this.getPeersSummary());
  }

  // --- DISCONNECT & TEARDOWN ---

  sendLeaveBeacon() {
    if (!this.activeRoomId) return;
    const body = JSON.stringify({ roomId: this.activeRoomId, peerId: this.myPeerId });
    try {
      navigator.sendBeacon?.('/api/room/leave', new Blob([body], { type: 'application/json' }));
    } catch { /* best effort */ }
  }

  disconnect({ quiet = false } = {}) {
    const wasInRoom = !!this.activeRoomId;
    this.session = null;
    this.stopStatsMonitoring();
    this.broadcast({ type: 'bye' });
    this.stopScreenShare();
    this.stopMic();
    this.stopCamera();

    if (wasInRoom) {
      fetch('/api/room/leave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // final: left on purpose (not a reload/closed tab), so an empty room can go right away.
        body: JSON.stringify({ roomId: this.activeRoomId, peerId: this.myPeerId, final: true }),
        keepalive: true
      }).catch(() => {});
    }

    for (const id of [...this.peers.keys()]) this.removePeer(id);
    this.watching.clear();
    this.roster.clear();
    this.orphanedCandidates.clear();
    this.outbox.clear();
    this.activeRoomId = null;
    this.roomJoined = false;
    this.setStatus('closed');
    this.notifyPeersUpdate();
    if (wasInRoom && !quiet) this.log('Desconectado da sala.');
  }

  leaveRoom() {
    this.disconnect();
  }
}
