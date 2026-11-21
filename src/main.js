/**
 * Kennyy ScreenShare - P2P Application Controller
 * Follows Kennyy Monochrome aesthetic standard & Google Meet / Kennyy layout.
 */

import { KScreenEngine } from './sfu-engine.js';
import { SHARE_RESOLUTIONS, SHARE_FPS, SHARE_AUDIO_QUALITIES, DEFAULT_SHARE_SETTINGS, validShareSettings, FORCE_RELAY_KEY } from './webrtc.js';
import { tr, startTranslating, lang, langChoice, setLangChoice, effectiveLang, systemLang } from './i18n.js';
import { initSettings } from './settings.js';
import { openProfile, closeProfile } from './profile.js';
import { RoomChat, chatBadge } from './chat.js';
import { initSliderTips } from './slider-tip.js';
import { P2PFiles } from './p2p-files.js';
import { openColorPicker, closeColorPicker } from './color-picker.js';
import { initP2PAvatars, resolveP2PAvatar, saveLocalAvatar, parseP2PAvatar, isSpinnerAvatar } from './p2p-avatars.js';
import { spinnerHtml } from './spinner.js';

// Swaps a button's label for the spinner (same width) and back.
function setButtonBusy(button, busy) {
  if (!button) return;
  if (busy) {
    if (button.dataset.idleHtml != null) return;
    button.dataset.idleHtml = button.innerHTML;
    button.style.minWidth = `${button.offsetWidth}px`;
    button.innerHTML = spinnerHtml('btn-spinner');
    button.classList.add('is-busy');
    button.setAttribute('aria-busy', 'true');
    button.disabled = true;
  } else {
    if (button.dataset.idleHtml == null) return;
    button.innerHTML = button.dataset.idleHtml;
    delete button.dataset.idleHtml;
    button.style.minWidth = '';
    button.classList.remove('is-busy');
    button.removeAttribute('aria-busy');
    button.disabled = false;
  }
}

// System language: English unless the system is in Portuguese (see i18n.js).
startTranslating();
initSliderTips();

// Color Palette for Participant Cards
const PARTICIPANT_COLORS = [
  '#ea435c', // Coral pink
  '#7bc043', // Lime green
  '#4d7cfe', // Royal blue
  '#8e3a4b', // Burgundy wine
  '#6d3b3b', // Dark brown
  '#7a42b0', // Violet purple
  '#00897b', // Teal
  '#d81b60', // Fuchsia
  '#f39c12', // Amber orange
  '#2c3e50', // Dark slate
];

const AUTH_ERRORS = {
  discord_not_configured: 'Login com Discord não configurado no servidor (DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET).',
  auth_redirect: 'O endereço deste site não está nos Redirects do app no Discord Developer Portal.',
  auth_state: 'O login expirou ou foi aberto em outra aba. Tente novamente.',
  no_code: 'Login cancelado.',
  auth_internal_fail: 'Falha ao falar com o Discord. Tente novamente.'
};

// Helper to normalize room IDs (e.g. "et6hnjkkl" and "et6-hnj-kkl" resolve to the exact same room)
function normalizeRoomId(id) {
  if (!id) return '';
  const raw = String(id).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (raw.length === 9) {
    return `${raw.slice(0, 3)}-${raw.slice(3, 6)}-${raw.slice(6, 9)}`;
  }
  return raw;
}

// Up to 9 characters it looks like a generated code (xxx-xxx-xxx); longer ones are custom codes.
function formatRoomInput(text) {
  const raw = String(text).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
  if (raw.length > 9) return raw;
  if (raw.length <= 3) return raw;
  if (raw.length <= 6) return `${raw.slice(0, 3)}-${raw.slice(3)}`;
  return `${raw.slice(0, 3)}-${raw.slice(3, 6)}-${raw.slice(6)}`;
}

// Accepts a bare code or a full invite link
function extractRoomCode(text) {
  const value = String(text || '').trim();
  const match = value.match(/[?&]room=([a-z0-9-]+)/i);
  return match ? match[1] : value;
}

// Generated codes (xxx-xxx-xxx) or custom ones (4 to 20 letters or numbers).
function isValidRoomCode(code) {
  return /^[a-z0-9]{4,20}$/.test(String(code || '').replace(/-/g, ''));
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Stable color per participant (does not shift when someone leaves)
function colorFor(id) {
  let hash = 0;
  for (const ch of String(id)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PARTICIPANT_COLORS[hash % PARTICIPANT_COLORS.length];
}

function safeAvatar(url) {
  if (parseP2PAvatar(url)) return resolveP2PAvatar(url) || '/avatar.png';
  return /^(\/avatar\.png$|\/avatars\/[1-8]\.jpg$|https:\/\/cdn\.discordapp\.com\/)/.test(url || '') ? url : '/avatar.png';
}

// Card color = the dominant color of the person's avatar (like Discord's profile banners).
// avatarUrl -> '#rrggbb' once computed, or a pending promise.
const avatarColors = new Map();

function dominantColor(img) {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);
  // Bucket by 4 bits per channel; prefer saturated mid-tones over near-black/white backgrounds.
  const buckets = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
    if (a < 128) continue;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const light = (max + min) / 510;
    const sat = max === min ? 0 : (max - min) / (255 - Math.abs(max + min - 255));
    const weight = 1 + sat * 3 - (light < 0.08 || light > 0.92 ? 0.9 : 0);
    const key = (r >> 4) << 8 | (g >> 4) << 4 | (b >> 4);
    const bucket = buckets.get(key) || { weight: 0, r: 0, g: 0, b: 0, n: 0 };
    bucket.weight += weight;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    bucket.n++;
    buckets.set(key, bucket);
  }
  let best = null;
  for (const bucket of buckets.values()) if (!best || bucket.weight > best.weight) best = bucket;
  if (!best) return null;
  // Same hue as the avatar, but toned down (like Discord's banners) so a big card isn't garish
  // and white names stay readable.
  const [h, s, l] = rgbToHsl(best.r / best.n, best.g / best.n, best.b / best.n);
  return hslToHex(h, Math.min(s, 0.5), Math.min(Math.max(l, 0.22), 0.38));
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return `#${[r, g, b].map(v => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('')}`;
}

function cardColor(p) {
  if (isSpinnerAvatar(p.avatarUrl)) return colorFor(p.id);
  const cached = avatarColors.get(p.avatarUrl);
  if (typeof cached === 'string') return cached;
  if (!cached) {
    const pending = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        let color = null;
        try { color = dominantColor(img); } catch { /* tainted canvas: no CORS */ }
        resolve(color);
      };
      img.onerror = () => resolve(null);
      img.src = p.avatarUrl;
    }).then((color) => {
      avatarColors.set(p.avatarUrl, color || colorFor(p.avatarUrl));
      scheduleRender();
    });
    avatarColors.set(p.avatarUrl, pending);
  }
  return colorFor(p.id);
}

const ICON_MIC_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3 3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg>';
const ICON_DEAFENED = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 3a9 9 0 0 0-9 9v7c0 1.1.9 2 2 2h4v-8H5v-1a7 7 0 0 1 11.95-4.95l1.41-1.41A8.97 8.97 0 0 0 12 3zm7 7.2V13h-4v8h4c1.1 0 2-.9 2-2v-7c0-.62-.06-1.22-.18-1.8L19 10.2zM3.7 2.3 2.3 3.7l18 18 1.4-1.4-18-18z"/></svg>';

// Discord-style status icons next to the name. Only touches the DOM when the state changes.
const ICON_SPEAKER_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm18.3 6.9-1.4 1.4-2.9-2.9-2.9 2.9-1.4-1.4 2.9-2.9-2.9-2.9 1.4-1.4 2.9 2.9 2.9-2.9 1.4 1.4-2.9 2.9z"/></svg>';
const ICON_VIDEO_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21 6.5l-4 4V7a1 1 0 0 0-1-1H9.82L21 17.18V6.5zM3.27 2 2 3.27 4.73 6H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z"/></svg>';

// Their own mic / deafen state, plus what YOU turned off for them (only you see those):
// muted voice or stream (speaker icon) and hidden camera.
function renderVoiceIcons(el, p) {
  if (!el) return;
  const pid = p.pid || p.id;
  const mine = !p.isLocal && pid !== 'local' ? getAudioPrefs(pid) : null;
  const screen = String(p.id).endsWith(':screen');
  const silenced = !!mine && (screen ? mine.streamMuted : mine.muted);
  const hidden = !!mine && !screen && !!mine.videoOff && !!p.cameraOn;
  const key = `${p.micMuted ? 'm' : ''}${p.deafened ? 'd' : ''}${silenced ? 's' : ''}${hidden ? 'v' : ''}`;
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.innerHTML = `${p.micMuted ? `<span title="${tr('Microfone desligado')}">${ICON_MIC_OFF}</span>` : ''}`
    + `${p.deafened ? `<span title="${tr('Áudio desligado')}">${ICON_DEAFENED}</span>` : ''}`
    + `${silenced ? `<span class="local-off" title="${tr(screen ? 'Você silenciou esta transmissão' : 'Você silenciou esta pessoa')}">${ICON_SPEAKER_OFF}</span>` : ''}`
    + `${hidden ? `<span class="local-off" title="${tr('Você desativou o vídeo desta pessoa')}">${ICON_VIDEO_OFF}</span>` : ''}`;
}

// Three bars like Discord's connection indicator; exact ping on hover.
function renderSignal(el, p) {
  if (!el) return;
  const ping = Math.round(p.pingMs || 0);
  if (p.isLocal || !ping) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  el.dataset.quality = ping < 80 ? 'good' : ping <= 200 ? 'medium' : 'poor';
  el.title = `Ping: ${ping} ms`;
  el.setAttribute('aria-label', `Ping ${ping} ms`);
}

// ==========================================================================
// DOM ELEMENTS
// ==========================================================================

const $ = (id) => document.getElementById(id);

const loginScreen = $('login-screen');
const btnDiscordLogin = $('btn-discord-login');

const homeScreen = $('home-screen');
const btnHomeCreate = $('btn-home-create');
const createRoomModal = $('create-room-modal');
const createRoomForm = $('create-room-form');
const createRoomError = $('create-room-error');
const confirmModal = $('confirm-modal');
const roomPasswordModal = $('room-password-modal');
const roomPasswordForm = $('room-password-form');
const roomPasswordInput = $('room-password-input');
const roomPasswordCode = $('room-password-code');
const roomPasswordError = $('room-password-error');
const roomPasswordSubmit = $('room-password-submit');
const headerRoomLock = $('header-room-lock');
const homeJoinForm = $('home-join-form');
const homeRoomInput = $('home-room-input');
const btnHomeOk = $('btn-home-ok');
const homeUserAvatar = $('home-user-avatar');
const homeUserName = $('home-user-name');
const btnHomeLogout = $('btn-home-logout');

const kennyyTopbar = $('kennyy-topbar');
const headerRoomCode = $('header-room-code');
const btnCopyRoomCode = $('btn-copy-room-code');
const headerAvatar = $('header-avatar');
const headerStreamTitle = $('header-stream-title');
const btnToggleView = $('btn-toggle-view');
const iconViewGrid = $('icon-view-grid');
const iconViewSpotlight = $('icon-view-spotlight');
const viewModeLabel = $('view-mode-label');
const btnOpenDiagnostics = $('btn-open-diagnostics');
const topStatusDot = $('top-status-dot');
const topStatusText = $('top-status-text');

const kennyyStage = $('kennyy-stage');
const stageGridView = $('stage-grid-view');
const stageSpotlightView = $('stage-spotlight-view');
const spotlightMainCard = $('spotlight-main-card');
const spotlightVideo = $('spotlight-video');
const spotlightAvatarFallback = $('spotlight-avatar-fallback');
const spotlightFallbackAvatar = $('spotlight-fallback-avatar');
const spotlightFallbackTitle = $('spotlight-fallback-title');
const spotlightNametagText = $('spotlight-nametag-text');
const spotlightLiveDot = $('spotlight-live-dot');
const spotlightVoiceIcons = $('spotlight-voice-icons');
const spotlightSignal = $('spotlight-signal');
const btnStageFullscreen = $('btn-stage-fullscreen');
const participantsStrip = $('participants-strip');

const kennyyDockWrapper = $('kennyy-dock-wrapper');
const btnDockMic = $('btn-dock-mic');
const btnDockAudio = $('btn-dock-audio');
const btnDockCamera = $('btn-dock-camera');
const btnDockScreenshare = $('btn-dock-screenshare');
const btnDockEndcall = $('btn-dock-endcall');
const btnShareMenu = $('btn-dock-share-menu');
const shareMenu = $('share-menu');
const shareMain = $('share-main');
const shareSubmenu = $('share-submenu');
const shareMenuQuality = $('share-menu-quality');
const shareMenuAudio = $('share-menu-audio');
const shareMenuAudioRow = $('share-menu-audio-row');
const shareMenuStatus = $('share-menu-status');
const shareResolutionOptions = $('share-resolution-options');
const shareFpsOptions = $('share-fps-options');

const diagnosticsModal = $('diagnostics-modal');
const btnCloseDiagnostics = $('btn-close-diagnostics');
const statsConnType = $('stats-conn-type');
const statsPing = $('stats-ping');
const statsProtocol = $('stats-protocol');
const telemetryPeersTable = $('telemetry-peers-table');
const btnIceRestart = $('btn-ice-restart');
const btnOpenSecondTab = $('btn-open-second-tab');
const logConsole = $('log-console');
const toastContainer = $('toast-container');

const videoContextMenu = $('video-context-menu');
const ctxVolumeSlider = $('ctx-volume-slider');
const ctxVolumeBox = $('ctx-volume-box');
const ctxVolumeTitle = ctxVolumeBox?.querySelector('.ctx-volume-title');
const ctxBtnMute = $('ctx-btn-mute');
const ctxVideoOff = $('ctx-video-off');
const ctxWatchStop = $('ctx-row-watch');
const ctxShowNoVideo = $('ctx-show-novideo');

// ==========================================================================
// APPLICATION STATE
// ==========================================================================

// Set from the server session (/api/auth/me); never trusted from local storage.
let currentUser = null;
let currentViewMode = 'grid'; // 'grid' | 'spotlight'
let activeSpotlightId = null; // null | 'local' | peerId
let pinnedSpotlight = false;  // user picked someone manually; don't auto-switch away
const pausedStreams = new Set();  // own stream previews paused while the app is unfocused
const endedStreams = new Map(); // ended streams still shown, pid -> 2 min timer
let watchedLive = new Set();      // streams I watched in the last render
let isLocalSharing = false;
let localStream = null;
let isAudioMuted = false;
let myNickname = displayNameOf(currentUser);
let wakeLock = null;
let contextMenuTargetId = null;
let contextMenuTileId = null;
let renderQueued = false;
let localStreamShown = null;

// Remote audio: peerId -> { source, gain, element, key }
const audioPipelines = new Map();
let audioContext = null;

// v2: the text mode is gone and games (60 FPS) is the default, so old saved settings are ignored.
const SHARE_SETTINGS_KEY = 'kennyy_share_settings_v2';

function loadShareSettings() {
  try {
    return validShareSettings(JSON.parse(localStorage.getItem(SHARE_SETTINGS_KEY) || '{}'));
  } catch {
    return validShareSettings();
  }
}

function saveShareSettings(settings) {
  try { localStorage.setItem(SHARE_SETTINGS_KEY, JSON.stringify(validShareSettings(settings))); } catch { /* private mode */ }
}

const engine = new KScreenEngine({
  peerName: myNickname,
  avatarUrl: safeAvatar(currentUser?.avatarUrl),
  shareSettings: loadShareSettings(),
  onStatusChange: (status) => handleStatusChange(status),
  onPeersUpdate: (peersList) => handlePeersUpdate(peersList),
  onPeerStream: () => scheduleRender(),
  onPeerStreamEnded: (peerId, kind) => handlePeerStreamEnded(peerId, kind),
  onLocalStream: (stream) => handleLocalStream(stream),
  // The desktop app's picker can change resolution/FPS before going live.
  onShareSettingsChange: (settings) => { saveShareSettings(settings); renderShareMenu(); },
  onCapturePaused: () => renderShareMenu(),
  onScreenShareEnded: () => handleLocalShareEnded(),
  onAuthRequired: () => handleSessionExpired(),
  onReplaced: (device) => {
    leaveCurrentRoom();
    showToast(tr(`Você entrou nesta sala em outro ${DEVICE_LABEL[device] || 'dispositivo'}. Esta janela saiu da chamada.`), 6000);
  },
  onVoiceStateChange: () => scheduleRender(),
  onLog: (logItem) => appendLog(logItem)
});

// Dev server only: lets tests and the console inspect the engine.
if (import.meta.env.DEV) window.kscreenEngine = engine;

// Room text chat (src/chat.js). Messages go through the server, so they reach everyone
// even when a P2P link failed, and people who join later see the history.
const btnDockChat = $('btn-dock-chat');
// Chat images travel P2P (data channel, or the media server); the server keeps the history and descriptions.
const chatFiles = new P2PFiles(engine);
const roomChat = new RoomChat({
  files: chatFiles,
  context: () => (engine.activeRoomId ? { roomId: engine.activeRoomId, peerId: engine.myPeerId } : null),
  me: () => currentUser,
  members: () => [...engine.roster.values()].map(p => ({ userId: p.userId, name: p.name, avatarUrl: p.avatarUrl })),
  onUnreadChange: (count, mention) => chatBadge(btnDockChat, count, mention),
  // Only a mention pings; ordinary messages stay silent.
  onNewMessage: ({ mention }) => { if (mention) playSound('mention'); },
  onProfile: (userId, el, author) => openProfile(userProfile(userId, author), el),
  toast: (message) => showToast(message),
  confirm: (opts) => confirmDialog(opts)
});
// Guest photos arrive over P2P after the first render: repaint cards, home and chat.
initP2PAvatars(chatFiles, () => {
  scheduleRender();
  roomChat.render();
  if (homeUserAvatar && currentUser) homeUserAvatar.src = safeAvatar(currentUser.avatarUrl);
});

btnDockChat?.addEventListener('click', () => {
  roomChat.toggle();
  btnDockChat.classList.toggle('active', roomChat.open);
});
new MutationObserver(() => btnDockChat?.classList.toggle('active', document.body.classList.contains('chat-open')))
  .observe(document.body, { attributes: true, attributeFilter: ['class'] });

// ==========================================================================
// Discord photos that stopped loading (the person changed it): any <img> on the page, in the
// call, the chat or the people list. It shows the default picture, the server fetches the
// current photo and every image of that person switches to it (the others get it on their poll).
// ==========================================================================
const DISCORD_AVATAR_RE = /^https:\/\/cdn\.discordapp\.com\/avatars\/(\d{5,25})\//;
const freshAvatars = new Map(); // userId -> Promise<string|null>

function refreshDiscordAvatar(userId) {
  if (!freshAvatars.has(userId)) {
    freshAvatars.set(userId, fetch('/api/avatar/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId })
    }).then(r => (r.ok ? r.json() : null)).then(d => d?.avatarUrl || null).catch(() => null));
  }
  return freshAvatars.get(userId);
}

document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;
  const match = DISCORD_AVATAR_RE.exec(img.currentSrc || img.src);
  if (!match) return;
  const [broken, userId] = match;
  img.dataset.brokenAvatar = userId;
  img.src = '/avatar.png';
  refreshDiscordAvatar(userId).then((url) => {
    if (!url || url.startsWith(broken)) return;
    for (const other of document.querySelectorAll('img')) {
      if (other.dataset.brokenAvatar === userId || (other.src || '').startsWith(broken)) {
        delete other.dataset.brokenAvatar;
        other.src = url;
      }
    }
    if (currentUser && String(currentUser.id) === userId) currentUser.avatarUrl = url;
  });
}, true);

// ==========================================================================
// AUTHENTICATION & NAVIGATION (Discord login is required)
// ==========================================================================

async function fetchCurrentUser() {
  try {
    const res = await fetch('/api/auth/me', { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()).user || null;
  } catch {
    return null;
  }
}

function displayNameOf(user) {
  return user ? (user.displayName || user.username || 'Usuário') : 'Usuário';
}

function handleSessionExpired() {
  if (engine.activeRoomId) leaveCurrentRoom({ keepUrl: true });
  currentUser = null;
  updateNavigation();
  showToast('Sua sessão expirou. Entre de novo.', 5000);
}

function setRoomInUrl(roomId) {
  const url = new URL(location.href);
  if (roomId) url.searchParams.set('room', roomId);
  else url.searchParams.delete('room');
  url.searchParams.delete('error');
  history.replaceState(null, '', url);
}

function updateNavigation() {
  const isInRoom = !!engine.activeRoomId;
  roomChat.setRoom(isInRoom && currentUser ? engine.activeRoomId : null);
  // Desktop app: the title bar shows the room code (and a lock for rooms with a password).
  window.kscreenDesktop?.roomState?.({ room: isInRoom ? engine.activeRoomId : null, locked: isInRoom && !!engine.roomLocked });

  if (!currentUser) {
    loginScreen?.classList.remove('hidden');
    homeScreen?.classList.add('hidden');
    kennyyTopbar?.classList.add('hidden');
    kennyyStage?.classList.add('hidden');
    kennyyDockWrapper?.classList.add('hidden');
    $('btn-room-settings')?.classList.add('hidden');
    return;
  }

  loginScreen?.classList.add('hidden');
  myNickname = displayNameOf(currentUser);
  engine.myPeerName = myNickname;
  engine.myAvatarUrl = currentUser.avatarUrl || '/avatar.png';

  if (homeUserName) homeUserName.textContent = myNickname;
  if (homeUserAvatar) homeUserAvatar.src = safeAvatar(currentUser.avatarUrl);

  homeScreen?.classList.toggle('hidden', isInRoom);
  kennyyTopbar?.classList.toggle('hidden', !isInRoom);
  kennyyStage?.classList.toggle('hidden', !isInRoom);
  kennyyDockWrapper?.classList.toggle('hidden', !isInRoom);
  btnStageFullscreen?.classList.toggle('hidden', !isInRoom || !document.documentElement.requestFullscreen);
  $('btn-room-settings')?.classList.toggle('hidden', !isInRoom);
  try { wakeControls(); } catch { /* runs before the idle controls are set up */ }
  $('stage-volume')?.classList.toggle('hidden', !isInRoom);
  if (isInRoom) renderStage();
  else homeRoomInput?.focus({ preventScroll: true });
}

btnDiscordLogin?.addEventListener('click', () => {
  // Come back to the invited room after the OAuth round-trip
  const returnTo = location.pathname + location.search;
  window.location.href = `/api/auth/discord/login?returnTo=${encodeURIComponent(returnTo)}`;
});

// ==========================================================================
// GUEST LOGIN: name required; photo (up to 5 MB, any format the browser decodes)
// and name color optional (auto = derived from the photo).
// ==========================================================================

const GUEST_PHOTO_MAX = 5 * 1024 * 1024;
const guestModal = $('guest-modal');
const guestForm = $('guest-form');
const guestName = $('guest-name');
const guestError = $('guest-error');
const guestPreview = $('guest-avatar-preview');
const guestFile = $('guest-avatar-input');
const guestRemove = $('guest-avatar-remove');
const guestColorBtn = $('guest-color-btn');
const guestColorHex = $('guest-color-hex');
const guestSubmit = $('guest-submit');
// avatar: data URL sent to the server; autoColor: from the photo; pickedColor: the user's choice (wins).
const guestState = { avatar: null, autoColor: null, pickedColor: null, defaultAvatar: 1 };

// No photo of their own: a random one of public/avatars/1..8.jpg (name color follows it too).
function guestRandomDefault() {
  guestState.defaultAvatar = 1 + Math.floor(Math.random() * 8);
  guestState.autoColor = null;
  guestPreview.src = `/avatars/${guestState.defaultAvatar}.jpg`;
  loadImage(guestPreview.src).then((img) => {
    if (guestState.avatar) return;
    guestState.autoColor = nameColorFromImage(img);
    guestPaintColor();
  }).catch(() => {});
  guestPaintColor();
}

function guestShowError(message) {
  guestError.textContent = message || '';
  guestError.classList.toggle('hidden', !message);
}

function guestPaintColor() {
  const color = guestState.pickedColor || guestState.autoColor;
  guestColorBtn.style.background = color || '';
  if (document.activeElement !== guestColorHex) guestColorHex.value = guestState.pickedColor ? guestState.pickedColor.toUpperCase() : '';
  guestColorHex.placeholder = guestState.autoColor ? `Automática (${guestState.autoColor.toUpperCase()})` : 'Automática';
}

// The avatar's dominant hue, bright enough to read as a name on the dark UI.
function nameColorFromImage(img) {
  const base = dominantColor(img);
  if (!base) return null;
  const n = parseInt(base.slice(1), 16);
  const [h, sat] = rgbToHsl(n >> 16 & 255, n >> 8 & 255, n & 255);
  return sat < 0.08 ? '#dcdde3' : hslToHex(h, Math.max(Math.min(sat * 1.6, 0.8), 0.45), 0.68);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Center-crop to a 256px square; WebP when the browser can encode it, else JPEG.
function squareAvatar(img) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
  let url = canvas.toDataURL('image/webp', 0.86);
  if (!url.startsWith('data:image/webp')) url = canvas.toDataURL('image/jpeg', 0.86);
  return url;
}

async function guestPickPhoto(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) return guestShowError('Escolha um arquivo de imagem.');
  if (file.size > GUEST_PHOTO_MAX) return guestShowError('A foto pode ter no máximo 5 MB.');
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('empty');
    guestState.avatar = squareAvatar(img);
    guestState.autoColor = nameColorFromImage(img);
    guestPreview.src = guestState.avatar;
    guestRemove.classList.remove('hidden');
    guestShowError('');
    guestPaintColor();
  } catch {
    guestShowError('Não foi possível ler essa imagem. Tente outro formato.');
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function closeGuestModal() {
  closeColorPicker();
  closeModal(guestModal);
}

$('btn-guest-login')?.addEventListener('click', () => {
  guestShowError('');
  if (!guestState.avatar) guestRandomDefault();
  openModal(guestModal, guestName);
});
$('guest-avatar-pick')?.addEventListener('click', () => guestFile.click());
guestFile?.addEventListener('change', () => { guestPickPhoto(guestFile.files[0]); guestFile.value = ''; });
guestRemove?.addEventListener('click', () => {
  guestState.avatar = null;
  guestRemove.classList.add('hidden');
  guestRandomDefault();
});
guestColorBtn?.addEventListener('click', () => {
  openColorPicker({
    anchor: guestColorBtn,
    value: guestState.pickedColor || guestState.autoColor || '#e8365d',
    onInput: (hex) => { guestState.pickedColor = hex; guestPaintColor(); }
  });
});
guestColorHex?.addEventListener('input', () => {
  let raw = guestColorHex.value.trim();
  if (!raw) { guestState.pickedColor = null; guestPaintColor(); return; }
  if (!raw.startsWith('#')) raw = `#${raw}`;
  if (/^#[0-9a-f]{6}$/i.test(raw)) { guestState.pickedColor = raw.toLowerCase(); guestPaintColor(); }
});
guestColorHex?.addEventListener('blur', guestPaintColor);
guestModal?.querySelector('[data-close-modal]')?.addEventListener('click', closeGuestModal);
guestModal?.addEventListener('pointerdown', (e) => { if (e.target === guestModal) closeGuestModal(); });
guestModal?.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeGuestModal(); });

guestForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = guestName.value.replace(/\s+/g, ' ').trim();
  if (name.length < 2) {
    guestShowError('Escolha um nome (mínimo 2 caracteres).');
    guestName.focus();
    return;
  }
  closeColorPicker();
  setButtonBusy(guestSubmit, true);
  try {
    const photo = await saveLocalAvatar(guestState.avatar);
    const res = await fetch('/api/auth/guest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, defaultAvatar: guestState.defaultAvatar, avatarHash: photo?.hash, avatarSize: photo?.size, nameColor: guestState.pickedColor || guestState.autoColor })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.user) throw new Error(data.error || 'Não foi possível entrar. Tente novamente.');
    currentUser = data.user;
    closeModal(guestModal);
    updateNavigation();
    joinFromUrl(); // invite link → straight into the room
  } catch (err) {
    guestShowError(err.message);
  } finally {
    setButtonBusy(guestSubmit, false);
  }
});

// Also used by Settings > Minha conta, which can be opened inside a room.
async function logout() {
  if (engine.activeRoomId) leaveCurrentRoom();
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  currentUser = null;
  updateNavigation();
  showToast('Você saiu da conta.');
}
btnHomeLogout?.addEventListener('click', logout);

// ==========================================================================
// HOME SCREEN ACTIONS
// ==========================================================================

if (homeRoomInput) {
  homeRoomInput.addEventListener('input', (e) => {
    e.target.value = formatRoomInput(e.target.value);
  });

  homeRoomInput.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text') || '';
    homeRoomInput.value = formatRoomInput(extractRoomCode(text));
  });
}

async function enterRoom(action, busyButton, busyText) {
  setButtonBusy(busyButton, true);
  try {
    const roomId = await action();
    if (headerRoomCode) headerRoomCode.textContent = roomId;
    headerRoomLock?.classList.toggle('hidden', !engine.roomLocked);
    setRoomInUrl(roomId);
    updateNavigation();
    restoreVoiceState();
    return roomId;
  } finally {
    setButtonBusy(busyButton, false);
  }
}

// --------------------------------------------------------------------------
// Modals (same card as the Kennyy web player): new room, confirmation
// --------------------------------------------------------------------------

function openModal(el, focus) {
  el.classList.remove('hidden');
  focus?.focus();
}

function closeModal(el) {
  el?.classList.add('hidden');
}

// Promise-based "Tem certeza?" (replaces window.confirm).
let confirmResolve = null;
function confirmDialog({ title, message = '', confirmLabel = 'OK', danger = false }) {
  confirmResolve?.(false);
  $('confirm-modal-title').textContent = title;
  $('confirm-modal-message').textContent = message;
  $('confirm-modal-message').parentElement.classList.toggle('hidden', !message);
  const ok = $('confirm-modal-ok');
  ok.textContent = confirmLabel;
  ok.classList.toggle('is-danger', danger);
  openModal(confirmModal, ok);
  return new Promise((resolve) => { confirmResolve = resolve; });
}

function settleConfirm(result) {
  closeModal(confirmModal);
  const resolve = confirmResolve;
  confirmResolve = null;
  resolve?.(result);
}

$('confirm-modal-ok')?.addEventListener('click', () => settleConfirm(true));
$('confirm-modal-cancel')?.addEventListener('click', () => settleConfirm(false));
confirmModal?.addEventListener('pointerdown', (e) => { if (e.target === confirmModal) settleConfirm(false); });

// Recent room settings (code, password, limit), per account and only in this browser:
// one click in the "Nova sala" modal fills the form like last time. Pinned ones (up to 3)
// come first and never drop off the list; the other recent ones are the last 4.
const RECENT_ROOMS_MAX = 4;
const RECENT_PINNED_MAX = 3;
const recentRoomsKey = () => `kscreen.recentRooms.${currentUser?.id || 'anon'}`;
const LIMIT_LABELS = { 0: 'ilimitado', 2: '2 pessoas', 5: '5 pessoas', 10: '10 pessoas' };
const RECENT_ICON_CLOCK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>';
const RECENT_ICON_LOCK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
const RECENT_ICON_USERS = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M17 11a4 4 0 0 0 0-8M22 21a7 7 0 0 0-4-6.3"/></svg>';
const RECENT_ICON_PIN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';
const RECENT_ICON_PIN_FILLED = RECENT_ICON_PIN.replace('fill="none"', 'fill="currentColor"').replace('width="14" height="14"', 'width="16" height="16"');
const RECENT_ICON_X = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

function loadRecentRooms() {
  try {
    const list = JSON.parse(localStorage.getItem(recentRoomsKey()) || '[]');
    return Array.isArray(list) ? trimRecentRooms(list.filter(r => r && typeof r === 'object').map(r => ({
      code: typeof r.code === 'string' && isValidRoomCode(r.code) ? r.code : '',
      password: typeof r.password === 'string' ? r.password.slice(0, 64) : '',
      maxPeers: r.maxPeers in LIMIT_LABELS ? Number(r.maxPeers) : 0,
      pinned: r.pinned === true
    }))) : [];
  } catch { return []; }
}

// Pinned first (at most 3), then the last 4 recent ones.
function trimRecentRooms(list) {
  return [
    ...list.filter(r => r.pinned).slice(0, RECENT_PINNED_MAX),
    ...list.filter(r => !r.pinned).slice(0, RECENT_ROOMS_MAX)
  ];
}

function saveRecentRooms(list) {
  try { localStorage.setItem(recentRoomsKey(), JSON.stringify(trimRecentRooms(list))); } catch { /* storage blocked */ }
}

const sameRecent = (a, b) => a.code === b.code && a.password === b.password && a.maxPeers === b.maxPeers;

// A pinned room created again stays where it is; anything else goes to the top of the recent ones.
function rememberRecentRoom(entry) {
  const list = loadRecentRooms();
  if (list.some(r => r.pinned && sameRecent(r, entry))) return;
  saveRecentRooms([{ ...entry, pinned: false }, ...list.filter(r => !sameRecent(r, entry))]);
}

function renderRecentRooms() {
  const box = $('create-room-recent');
  const listEl = $('create-room-recent-list');
  if (!box || !listEl) return;
  const list = loadRecentRooms();
  const pinFull = list.filter(r => r.pinned).length >= RECENT_PINNED_MAX;
  box.classList.toggle('hidden', !list.length);
  listEl.innerHTML = list.map((r, i) => `
    <div class="room-recent${r.pinned ? ' is-pinned' : ''}">
      <button type="button" class="room-recent-pick" data-recent="${i}">
        <span class="room-recent-icon"${r.pinned ? ' title="Fixada"' : ''}>${r.pinned ? RECENT_ICON_PIN_FILLED : RECENT_ICON_CLOCK}</span>
        <span class="room-recent-code${r.code ? '' : ' is-generated'}">${r.code ? escapeHtml(normalizeRoomId(r.code)) : '<span>Código gerado</span>'}</span>
        <span class="room-recent-tags">
          ${r.password ? `<span class="room-recent-tag" title="Sala com senha">${RECENT_ICON_LOCK}</span>` : ''}
          <span class="room-recent-tag" title="${LIMIT_LABELS[r.maxPeers]}">${RECENT_ICON_USERS}${r.maxPeers || '∞'}</span>
        </span>
      </button>
      <span class="room-recent-actions">
        ${r.pinned
          ? `<button type="button" class="room-recent-action" data-recent-pin="${i}" title="Desafixar" aria-label="Desafixar" aria-pressed="true">${RECENT_ICON_PIN}</button>`
          : `<button type="button" class="room-recent-action" data-recent-pin="${i}" title="${pinFull ? 'Até 3 salas fixadas' : 'Fixar'}" aria-label="Fixar" aria-pressed="false"${pinFull ? ' disabled' : ''}>${RECENT_ICON_PIN}</button>`}
        <button type="button" class="room-recent-action" data-recent-remove="${i}" title="Remover" aria-label="Remover">${RECENT_ICON_X}</button>
      </span>
    </div>`).join('');
}

$('create-room-recent-list')?.addEventListener('click', (e) => {
  const pin = e.target.closest('[data-recent-pin]');
  if (pin) {
    const list = loadRecentRooms();
    const r = list[Number(pin.dataset.recentPin)];
    if (!r || (!r.pinned && list.filter(x => x.pinned).length >= RECENT_PINNED_MAX)) return;
    r.pinned = !r.pinned;
    saveRecentRooms(list);
    renderRecentRooms();
    return;
  }
  const remove = e.target.closest('[data-recent-remove]');
  if (remove) {
    const list = loadRecentRooms();
    list.splice(Number(remove.dataset.recentRemove), 1);
    saveRecentRooms(list);
    renderRecentRooms();
    return;
  }
  const pick = e.target.closest('[data-recent]');
  const r = pick && loadRecentRooms()[Number(pick.dataset.recent)];
  if (!r) return;
  $('create-room-code').value = r.code;
  $('create-room-password').value = r.password;
  const radio = createRoomForm.querySelector(`input[name="create-room-limit"][value="${r.maxPeers}"]`);
  if (radio) radio.checked = true;
  createRoomError.classList.add('hidden');
  for (const el of $('create-room-recent-list').querySelectorAll('.room-recent-pick')) el.classList.toggle('is-active', el === pick);
  $('create-room-submit').focus();
});

btnHomeCreate?.addEventListener('click', () => {
  createRoomForm.reset();
  createRoomError.classList.add('hidden');
  renderRecentRooms();
  openModal(createRoomModal, $('create-room-code'));
});

// Typing over a picked recent room: it is no longer that one.
createRoomForm?.addEventListener('input', () => {
  for (const el of createRoomForm.querySelectorAll('.room-recent-pick.is-active')) el.classList.remove('is-active');
});

// Custom code: only what the server accepts (lowercase letters and numbers).
$('create-room-code')?.addEventListener('input', (e) => {
  const clean = e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (clean !== e.target.value) e.target.value = clean;
});

createRoomModal?.querySelector('[data-close-modal]')?.addEventListener('click', () => closeModal(createRoomModal));
createRoomModal?.addEventListener('pointerdown', (e) => { if (e.target === createRoomModal) closeModal(createRoomModal); });

createRoomForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = $('create-room-password').value;
  const code = $('create-room-code').value.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (code && !isValidRoomCode(code)) {
    createRoomError.textContent = 'O código deve ter de 4 a 20 letras ou números.';
    createRoomError.classList.remove('hidden');
    $('create-room-code').focus();
    return;
  }
  const maxPeers = Number(createRoomForm.querySelector('input[name="create-room-limit"]:checked')?.value) || 0;
  const submit = $('create-room-submit');
  submit.disabled = true;
  try {
    const roomId = await enterRoom(() => engine.createRoom(myNickname, engine.myAvatarUrl, { password, maxPeers, code }), submit, 'Criando...');
    closeModal(createRoomModal);
    rememberRecentRoom({ code, password, maxPeers });
    showToast(`Sala ${roomId} criada.`);
  } catch (err) {
    console.error('Erro ao criar sala:', err);
    createRoomError.textContent = err.message && !/fetch/i.test(err.message) ? err.message : 'Não foi possível criar a sala. Verifique a conexão.';
    createRoomError.classList.remove('hidden');
  } finally {
    submit.disabled = false;
  }
});

// Protected rooms: ask for the password and retry the join until it works or the user cancels.
let passwordAttempt = null;

function closePasswordPrompt() {
  roomPasswordModal?.classList.add('hidden');
  passwordAttempt?.resolve(false);
  passwordAttempt = null;
}

function askRoomPassword(code, tryPassword) {
  passwordAttempt?.resolve(false);
  return new Promise((resolve) => {
    passwordAttempt = { resolve, tryPassword };
    roomPasswordCode.textContent = code;
    roomPasswordInput.value = '';
    roomPasswordError.classList.add('hidden');
    roomPasswordModal.classList.remove('hidden');
    roomPasswordInput.focus();
  });
}

roomPasswordForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const attempt = passwordAttempt;
  if (!attempt || !roomPasswordInput.value) return;
  roomPasswordSubmit.disabled = true;
  try {
    await attempt.tryPassword(roomPasswordInput.value);
    roomPasswordModal.classList.add('hidden');
    passwordAttempt = null;
    attempt.resolve(true);
  } catch (err) {
    roomPasswordError.textContent = ['PASSWORD_WRONG', 'TOO_MANY', 'ROOM_FULL'].includes(err.code) ? err.message : 'Não foi possível entrar na sala.';
    roomPasswordError.classList.remove('hidden');
    roomPasswordInput.select();
  } finally {
    roomPasswordSubmit.disabled = false;
  }
});

$('room-password-cancel')?.addEventListener('click', closePasswordPrompt);
roomPasswordModal?.addEventListener('pointerdown', (e) => {
  if (e.target === roomPasswordModal) closePasswordPrompt();
});

// Joins a room; if it has a password, asks for it. Resolves true when inside the room.
async function joinRoomByCode(code, busyButton) {
  try {
    await enterRoom(() => engine.joinRoom(code, myNickname, engine.myAvatarUrl, { fresh: true }), busyButton, '...');
    return true;
  } catch (err) {
    if (err.code !== 'PASSWORD_REQUIRED' && err.code !== 'TOO_MANY') throw err;
    return askRoomPassword(code, (password) => enterRoom(() => engine.joinRoom(code, myNickname, engine.myAvatarUrl, { password, fresh: true })));
  }
}

async function handleJoinHomeRoom() {
  const code = normalizeRoomId(homeRoomInput.value);
  if (!isValidRoomCode(code)) {
    showToast(code ? 'Código inválido.' : 'Digite o código da sala.');
    homeRoomInput.focus();
    return;
  }
  try {
    if (await joinRoomByCode(code, btnHomeOk)) showToast(`Você entrou na sala ${code}.`);
  } catch (err) {
    console.error('Falha ao entrar na sala:', err);
    showToast(['ROOM_FULL', 'ROOM_NOT_FOUND'].includes(err.code) ? err.message : 'Não foi possível entrar na sala.');
  }
}

homeJoinForm?.addEventListener('submit', (e) => {
  e.preventDefault();
  handleJoinHomeRoom();
});

function joinFromUrl() {
  const params = new URLSearchParams(location.search);
  const roomParam = normalizeRoomId(params.get('room'));
  if (!roomParam) return;
  if (homeRoomInput) homeRoomInput.value = roomParam;
  if (!currentUser || engine.activeRoomId) return;
  joinRoomByCode(roomParam)
    .then((joined) => { if (joined) showToast(`Você entrou na sala ${roomParam}.`); })
    .catch((err) => showToast(err.code === 'ROOM_FULL' ? err.message : err.code === 'ROOM_NOT_FOUND' ? 'O código do link é inválido.' : 'Não foi possível entrar na sala do link.'));
}

// ==========================================================================
// TOAST NOTIFICATIONS
// ==========================================================================

function showToast(message, duration = 3200) {
  if (!toastContainer) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.setAttribute('role', 'status');
  toast.textContent = message;
  toastContainer.appendChild(toast);
  while (toastContainer.children.length > 3) toastContainer.firstChild.remove();

  setTimeout(() => {
    toast.classList.add('leaving');
    setTimeout(() => toast.remove(), 250);
  }, duration);
}

// ==========================================================================
// STATUS & ROSTER HANDLING
// ==========================================================================

function handleStatusChange(status) {
  if (!topStatusDot || !topStatusText) return;
  const labels = {
    connected: ['connected', 'P2P conectado'],
    connecting: ['connecting', 'Conectando...'],
    waiting: ['', 'Aguardando amigos']
  };
  const [dotClass, text] = labels[status] || ['', 'Desconectado'];
  topStatusDot.className = `status-dot ${dotClass}`.trim();
  topStatusText.textContent = text;
}

function handlePeersUpdate(peersList) {
  scheduleRender();
  if (diagnosticsModal && !diagnosticsModal.classList.contains('hidden')) renderTelemetryModal(peersList);
}

function handlePeerStreamEnded(peerId, kind) {
  if (kind === 'all') removeAudioPipeline(peerId);
  scheduleRender();
}

// Many engine events can fire in one tick; render once per frame.
// rAF never fires in background tabs, and remote audio is wired up during render,
// so a timer guarantees the render still happens there.
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  const run = () => {
    if (!renderQueued) return;
    renderQueued = false;
    renderStage();
  };
  requestAnimationFrame(run);
  setTimeout(run, 100);
}

// ==========================================================================
// STAGE & VIEWS RENDERING (GRID & SPOTLIGHT)
// ==========================================================================

// Menus fade in (CSS animation) and fade out here before being hidden.
function isShown(el) {
  return !!el && !el.classList.contains('hidden') && !el.classList.contains('fading-out');
}
function fadeShow(el) {
  if (!el) return;
  el.classList.remove('fading-out', 'hidden');
}
function fadeHide(el) {
  if (!isShown(el)) return;
  el.classList.add('fading-out');
  const done = () => {
    if (!el.classList.contains('fading-out')) return; // reopened meanwhile
    el.classList.remove('fading-out');
    el.classList.add('hidden');
  };
  el.addEventListener('animationend', done, { once: true });
  setTimeout(done, 220);
}

let showNoVideo = (() => { try { return localStorage.getItem('kscreen.showNoVideo') !== '0'; } catch { return true; } })();

function getParticipantList() {
  const list = [{
    id: 'local',
    name: myNickname,
    nameColor: currentUser?.nameColor || null,
    avatarUrl: safeAvatar(currentUser?.avatarUrl),
    device: engine.myDevice,
    isLocal: true,
    isStreaming: isLocalSharing,
    stream: localStream,
    audioStream: null,
    cameraOn: !!engine.cameraStream,
    cameraStream: engine.cameraStream,
    status: 'connected',
    pingMs: 0,
    micMuted: engine.isMicMuted,
    deafened: isAudioMuted,
    speaking: engine.isSpeaking
  }];

  for (const p of engine.peers.values()) {
    if (p.preview) lastPreviews.set(p.id, p.preview);
    list.push({
      id: p.id,
      name: p.name || 'Amigo',
      nameColor: engine.roster.get(p.id)?.nameColor || null,
      avatarUrl: safeAvatar(p.avatarUrl),
      device: p.device || engine.roster.get(p.id)?.device,
      isLocal: false,
      isStreaming: !!p.isStreaming,
      // Screen video only; camera has its own stream and audio is played from remoteStream
      stream: p.screenStream || p.remoteStream,
      audioStream: p.remoteStream,
      // Media-server (SFU) peers have no transceivers: their engine keeps the tracks directly.
      screenAudioTrack: p.screenAudioTrack || p.transceivers?.screenAudio?.receiver.track || null,
      micTrack: p.micTrack || p.transceivers?.mic?.receiver.track || null,
      watching: engine.watching.has(p.id),
      preview: p.preview,
      cameraOn: !!(p.cameraOn && p.cameraStream),
      cameraStream: p.cameraStream,
      status: p.status,
      pingMs: p.stats.pingMs || p.stats.rttMs || 0,
      micMuted: p.micMuted,
      deafened: p.deafened,
      speaking: p.speaking && !p.micMuted
    });
  }
  // People in the room without a connection right now (connecting, between attempts, or no route
  // at all): they stay on screen, with what the server knows (streaming, mic) instead of vanishing.
  for (const g of engine.ghosts?.() || []) {
    list.push({
      id: g.id,
      name: g.name || 'Amigo',
      nameColor: g.nameColor || null,
      avatarUrl: safeAvatar(g.avatarUrl),
      device: g.device,
      isLocal: false,
      isStreaming: !!g.state?.s,
      stream: null,
      audioStream: null,
      screenAudioTrack: null,
      micTrack: null,
      watching: engine.watching.has(g.id),
      // Last still frame we had of their stream (before the connection dropped or changed).
      preview: g.state?.s ? lastPreviews.get(g.id) || null : null,
      cameraOn: false,
      cameraStream: null,
      status: g.status,
      pingMs: 0,
      micMuted: g.state ? g.state.m !== false : true,
      deafened: !!g.state?.d,
      speaking: false
    });
  }
  return list;
}

// Last preview image per person, so a stream card keeps its picture while the connection to them
// is (re)made (P2P -> SFU, reconnecting).
const lastPreviews = new Map();

// A stream with no picture yet (connection to them being made, P2P -> SFU, server still
// connecting): the card stays, with a spinner, instead of vanishing until the video arrives.
function hasLiveVideo(stream) {
  return !!stream?.getVideoTracks().some(t => t.readyState === 'live');
}

// Discord-style: every person always has their own card (camera or avatar), and a stream is a
// separate card next to it. The person card keeps the id `<pid>:user`, so focus doesn't jump.
function getTiles(participants) {
  const tiles = [];
  for (const p of participants) {
    // The server's state (or the control channel) says they stream: the card shows even while
    // the video is not here yet, so nobody sees "ninguém transmitindo" while connecting.
    const hasScreen = !!p.isStreaming;
    const hasCamera = !!(p.cameraOn && p.cameraStream) && (p.isLocal || !getAudioPrefs(p.id).videoOff);
    {
      tiles.push({
        ...p,
        pid: p.id,
        id: `${p.id}:user`,
        kind: hasCamera ? 'camera' : 'avatar',
        mainStream: hasCamera ? p.cameraStream : null,
        mirror: hasCamera && p.isLocal,
        isStreaming: false
      });
    }
    if (!hasScreen && endedStreams.has(p.id)) {
      // Discord: a stream you watched that ended stays as a black "ended" card for a while.
      tiles.push({ ...p, pid: p.id, id: `${p.id}:screen`, kind: 'screen', mainStream: null, ended: true,
        unwatched: false, mirror: false, isStreaming: false, speaking: false, micMuted: false, deafened: false });
    }
    if (hasScreen) {
      // Someone else's stream only plays after "Assistir transmissão" (your own always shows).
      const watched = p.isLocal || p.watching;
      tiles.push({
        ...p,
        pid: p.id,
        id: `${p.id}:screen`,
        kind: 'screen',
        mainStream: watched && p.stream ? p.stream : null,
        unwatched: !watched,
        connecting: !!watched && !p.isLocal && !hasLiveVideo(p.stream),
        mirror: false,
        isStreaming: true,
        // Voice state lives on the person's card.
        speaking: false,
        micMuted: false,
        deafened: false
      });
    }
  }
  // Anything with a picture comes first: streams, then cameras, then people without video,
  // each group keeping the room order. On phones this keeps the full-width video cards
  // together and the two-per-row avatars paired at the end (no avatar left alone mid-grid).
  const rank = (t) => (t.kind === 'screen' ? 0 : t.kind === 'camera' ? 1 : 2);
  const ordered = tiles.slice().sort((a, b) => rank(a) - rank(b));
  // "Mostrar participantes sem vídeo" off: only cards with a picture stay (unless that is nobody).
  if (!showNoVideo && ordered.some(t => t.kind !== 'avatar')) return ordered.filter(t => t.kind !== 'avatar');
  return ordered;
}

// --------------------------------------------------------------------------
// Sound cues: files in public/sfx (synthesized blips as fallback while they load).
// They go through the room's AudioContext, so they use the chosen output device.
// --------------------------------------------------------------------------

// What plays is configurable (Settings > Sons): all on/off, a volume, and each kind of cue.
const SOUND_PREFS_KEY = 'kscreen.sounds';
const SOUND_DEFAULTS = { enabled: true, volume: 100, off: [] };
function loadSoundPrefs() {
  try {
    const v = JSON.parse(localStorage.getItem(SOUND_PREFS_KEY) || '{}');
    return {
      enabled: v.enabled !== false,
      volume: Number.isFinite(v.volume) ? Math.max(0, Math.min(100, v.volume)) : 100,
      off: Array.isArray(v.off) ? v.off.filter(x => typeof x === 'string') : []
    };
  } catch { return { ...SOUND_DEFAULTS, off: [] }; }
}
let soundPrefs = loadSoundPrefs();
function saveSoundPrefs() {
  try { localStorage.setItem(SOUND_PREFS_KEY, JSON.stringify(soundPrefs)); } catch { /* storage blocked */ }
}
// The rows of Settings > Sons; each row turns its cues on/off together.
const SOUND_CUES = [
  { keys: ['join', 'leave'], label: 'Entrada e saída de pessoas', hint: 'Alguém entra ou sai da sala.' },
  { keys: ['streamStart', 'streamStop'], label: 'Transmissões', hint: 'Alguém começa ou para de transmitir.' },
  { keys: ['viewerJoin', 'viewerLeave'], label: 'Espectadores', hint: 'Alguém começa ou para de assistir uma transmissão.' },
  { keys: ['mute', 'unmute'], label: 'Microfone', hint: 'Você liga ou desliga o microfone.' },
  { keys: ['deafen', 'undeafen'], label: 'Áudio da sala', hint: 'Você silencia ou ativa o áudio da sala.' },
  { keys: ['cameraOn', 'cameraOff'], label: 'Câmera', hint: 'Você liga ou desliga a câmera.' },
  { keys: ['mention'], label: 'Menções no chat', hint: 'Alguém menciona você.' }
];

const SOUNDS = {
  join: [[659, 0, 0.12], [880, 0.09, 0.18]],
  leave: [[880, 0, 0.12], [587, 0.09, 0.2]],
  streamStart: [[523, 0, 0.09], [659, 0.07, 0.09], [988, 0.14, 0.18]],
  streamStop: [[988, 0, 0.09], [659, 0.07, 0.09], [494, 0.14, 0.2]],
  mute: [[440, 0, 0.1], [330, 0.06, 0.12]],
  unmute: [[440, 0, 0.1], [587, 0.06, 0.12]],
  deafen: [[392, 0, 0.12], [262, 0.08, 0.18]],
  undeafen: [[262, 0, 0.12], [392, 0.08, 0.18]],
  message: [[784, 0, 0.07], [1047, 0.06, 0.12]],
  mention: [[880, 0, 0.08], [1175, 0.07, 0.08], [1397, 0.14, 0.16]]
};

// Cue name -> file in public/sfx.
const SOUND_FILES = {
  join: 'call_join', leave: 'call_left',
  // Anyone (you included) starts / stops a stream: everyone hears the same sound.
  streamStart: 'screenshare_on', streamStop: 'screenshare_off',
  // Someone starts / stops watching a stream: heard by its streamer and all its viewers.
  viewerJoin: 'screenshare_join', viewerLeave: 'screenshare_left',
  mute: 'mic_mute', unmute: 'mic_unmute',
  deafen: 'deafen', undeafen: 'undeafen',
  cameraOn: 'cam_on', cameraOff: 'cam_off',
  mention: 'ping'
};
// The files are downloaded as the page opens (no AudioContext needed for that) and decoded
// once there is one, so the first cue (creating a room) is already the real sound.
const soundFetches = new Map(Object.values(SOUND_FILES).map(file => [file,
  fetch(`${import.meta.env.BASE_URL}sfx/${file}.ogg`)
    .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.status))))
    .catch(() => null)
]));
const soundBuffers = new Map();
const soundDecodes = new Map();
function loadSounds(ctx) {
  if (soundDecodes.size) return;
  for (const [file, data] of soundFetches) {
    soundDecodes.set(file, data
      .then(bytes => (bytes ? ctx.decodeAudioData(bytes.slice(0)) : null))
      .then(buf => { if (buf) soundBuffers.set(file, buf); return buf; })
      .catch(() => null)); // keeps the synthesized fallback
  }
}

// Not decoded yet: wait a little for the file before falling back to the synthesized blip.
const SOUND_WAIT_MS = 1500;
async function playSound(name, { force = false } = {}) {
  if (!force && (!soundPrefs.enabled || soundPrefs.off.includes(name))) return;
  const ctx = getAudioContext();
  if (!ctx) return;
  const level = soundPrefs.volume / 100;
  loadSounds(ctx);
  const file = SOUND_FILES[name];
  if (file && !soundBuffers.has(file) && soundDecodes.has(file)) {
    await Promise.race([soundDecodes.get(file), new Promise(r => setTimeout(r, SOUND_WAIT_MS))]);
  }
  if (ctx.state !== 'running') return;
  const out = ctx.createGain();
  out.connect(ctx.destination);
  const buffer = soundBuffers.get(file);
  if (buffer) {
    out.gain.value = 0.5 * level * Math.min(1, devicePrefs.outVolume / 100);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(out);
    src.onended = () => { try { out.disconnect(); } catch { /* gone */ } };
    src.start();
    return;
  }
  const notes = SOUNDS[name] || SOUNDS[{ viewerJoin: 'join', viewerLeave: 'leave', cameraOn: 'unmute', cameraOff: 'mute' }[name]];
  if (!notes) { out.disconnect(); return; }
  out.gain.value = 0.16 * level * Math.min(1, devicePrefs.outVolume / 100);
  const t0 = ctx.currentTime + 0.01;
  for (const [freq, at, dur] of notes) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    // Short attack and smooth release: a soft "blip", no click.
    env.gain.setValueAtTime(0, t0 + at);
    env.gain.linearRampToValueAtTime(1, t0 + at + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
    osc.connect(env).connect(out);
    osc.start(t0 + at);
    osc.stop(t0 + at + dur + 0.02);
  }
  setTimeout(() => { try { out.disconnect(); } catch { /* gone */ } }, 1000);
}

// Join / leave and streams of other people are found by comparing with the last render.
const soundState = { room: null, since: 0, connected: new Set(), streaming: new Set(), audiences: new Map() };
function checkRoomSounds() {
  // Only once the server let us in: a wrong code or password never plays the join sound.
  const room = engine.roomJoined ? engine.activeRoomId : null;
  if (room !== soundState.room) {
    soundState.room = room;
    soundState.since = Date.now();
    soundState.connected = new Set();
    soundState.streaming = new Set();
    soundState.audiences = new Map();
    if (room) playSound('join');
  }
  if (!room) return;
  // The people already in the room connect right after you enter: no sound for each of them.
  const settling = Date.now() - soundState.since < 4000;
  const connected = new Set();
  const streaming = new Set();
  for (const p of engine.peers.values()) {
    if (p.status === 'connected' || soundState.connected.has(p.id)) connected.add(p.id);
    if (p.isStreaming) streaming.add(p.id);
  }
  if (!settling) {
    if ([...connected].some(id => !soundState.connected.has(id))) playSound('join');
    else if ([...soundState.connected].some(id => !connected.has(id))) playSound('leave');
    if ([...streaming].some(id => !soundState.streaming.has(id))) playSound('streamStart');
    else if ([...soundState.streaming].some(id => !streaming.has(id) && connected.has(id))) playSound('streamStop');
  }
  const wasConnected = soundState.connected;
  soundState.connected = connected;
  soundState.streaming = streaming;
  // Someone entering or leaving the call already got its own sound.
  checkViewerSounds((id) => id === 'local' || (wasConnected.has(id) && connected.has(id)));
}

// Each live stream you are part of (yours, or one you watch): its streamer and viewers hear
// when someone starts or stops watching, the one who just joined included.
function checkViewerSounds(stayed) {
  const audiences = new Map();
  const lives = [];
  if (isLocalSharing) lives.push('local');
  for (const p of engine.peers.values()) if (p.isStreaming) lives.push(p.id);
  for (const pid of lives) {
    const viewers = new Set(viewersOf(pid).map(v => v.id));
    const inside = pid === 'local' || viewers.has('local');
    audiences.set(pid, { viewers, inside });
  }
  let joined = false, left = false;
  for (const [pid, now] of audiences) {
    const before = soundState.audiences.get(pid);
    if (!before) continue;
    if (now.inside || before.inside) {
      if ([...now.viewers].some(id => !before.viewers.has(id) && stayed(id))) joined = true;
      else if ([...before.viewers].some(id => !now.viewers.has(id) && stayed(id))) left = true;
    }
  }
  if (joined) playSound('viewerJoin');
  else if (left) playSound('viewerLeave');
  soundState.audiences = audiences;
}

function renderStage() {
  try { paintStageVolume(); } catch { /* runs before the volume control is set up */ }
  paintEndcallButton();
  checkRoomSounds();
  if (!engine.activeRoomId) return;
  checkEndedStreams();

  const participants = getParticipantList();
  const tiles = getTiles(participants);
  const focused = tiles.find(t => t.id === activeSpotlightId);
  // Only a stream you are watching (or your own) takes the focus by itself.
  const streamer = tiles.find(t => t.kind === 'screen' && !t.isLocal && !t.unwatched) || tiles.find(t => t.kind === 'screen' && t.isLocal);
  if (!focused) {
    // The focused card went away (e.g. the person stopped sharing): fall back to their own card.
    const sameUser = activeSpotlightId && tiles.find(t => t.pid === activeSpotlightId.split(':')[0]);
    pinnedSpotlight = false;
    activeSpotlightId = streamer?.id || sameUser?.id || tiles[0].id;
  } else if (!pinnedSpotlight && focused.kind !== 'screen' && streamer) {
    activeSpotlightId = streamer.id;
  }
  // Discord: while the app window is out of focus (or hidden), your own stream's preview is
  // paused (black, "Sua transmissão ainda está ligada!") to save resources.
  const appUnfocused = document.hidden || !document.hasFocus();
  pausedStreams.clear();
  for (const t of tiles) {
    if (t.kind === 'screen' && t.isLocal && appUnfocused) {
      t.previewPaused = true;
      if (t.mainStream) pausedStreams.add(t.mainStream);
    }
  }

  updateHeader(tiles, participants.length);
  syncAudio(participants);

  const grid = currentViewMode === 'grid';
  stageGridView?.classList.toggle('hidden', !grid);
  stageSpotlightView?.classList.toggle('hidden', grid);
  if (grid) renderGridView(tiles);
  else renderSpotlightView(tiles);
  syncPopouts(tiles);
  // Paused previews keep their last frame frozen under the dark cover.
  for (const video of previewVideos()) {
    if (video.srcObject && pausedStreams.has(video.srcObject)) { if (!video.paused) video.pause(); }
    else if (video.srcObject && video.paused) video.play().catch(() => {});
  }
}

function updateHeader(tiles, peopleCount) {
  if (currentViewMode !== 'spotlight') renderHeaderLive(null);
  if (headerRoomCode) headerRoomCode.textContent = engine.activeRoomId || '';
  const streamers = tiles.filter(t => t.kind === 'screen');
  const focused = tiles.find(t => t.id === activeSpotlightId);

  if (currentViewMode === 'spotlight' && focused) {
    headerAvatar?.classList.remove('hidden');
    if (headerAvatar) headerAvatar.src = focused.avatarUrl;
    if (headerStreamTitle) headerStreamTitle.textContent = focused.kind === 'screen' ? `Tela de ${focused.name}` : focused.name;
  } else {
    headerAvatar?.classList.add('hidden');
    if (headerStreamTitle) {
      headerStreamTitle.textContent = streamers.length
        ? `${streamers.length === 1 ? `Tela de ${streamers[0].name}` : `${streamers.length} telas ao vivo`}`
        : `${peopleCount} na sala`;
    }
  }
}

function attachVideo(video, stream) {
  if (video.srcObject !== stream) video.srcObject = stream;
  // Remote audio always goes through the gain pipeline; videos stay muted.
  video.muted = true;
  if (video.paused) video.play().catch(() => {});
}

// --------------------------------------------------------------------------
// 1. GRID VIEW
// --------------------------------------------------------------------------

function renderGridView(participants) {
  if (!stageGridView) return;
  const ids = new Set(participants.map(p => p.id));

  for (const card of [...stageGridView.children]) {
    if (!ids.has(card.dataset.id)) {
      const video = card.querySelector('video');
      if (video) video.srcObject = null;
      card.remove();
    }
  }

  participants.forEach((p, index) => {
    let card = stageGridView.querySelector(`[data-id="${CSS.escape(p.id)}"]`);
    if (!card) {
      card = createParticipantCard(p.id, 'grid-participant-card', p.pid);
      card.innerHTML = `
        <div class="grid-card-avatar-content"><img class="grid-card-avatar" alt="" /></div>
        <div class="stream-cover hidden"><button type="button" class="watch-stream-btn">Assistir transmissão</button>${spinnerHtml()}</div>
        <div class="card-nametag"><span class="live-dot hidden"></span><span class="nametag-text"></span><span class="voice-icons"></span><span class="peer-state hidden"></span><span class="signal hidden" role="img"><i></i><i></i><i></i></span></div>`;
    }
    if (!card.dataset.wired) {
      card.dataset.wired = '1';
      card.querySelector('.watch-stream-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        watchStream(card.dataset.pid, card.dataset.id);
      });
      card.append(createStreamEnded(() => card.dataset.pid));
    }
    renderStreamEnded(card.querySelector('.stream-ended'), p);
    // Keep DOM order equal to participant order without re-creating nodes.
    if (stageGridView.children[index] !== card) stageGridView.insertBefore(card, stageGridView.children[index] || null);
    updateParticipantCard(card, p);
  });

  layoutGrid();
}

// `id` is the card (tile) id, `pid` the person it belongs to (menus act on the person).
function createParticipantCard(id, className, pid) {
  const card = document.createElement('div');
  card.className = className;
  card.dataset.id = id;
  card.dataset.pid = pid;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');

  // Discord-style: click someone to focus them; click the focused one again to go back to the grid.
  const focus = () => {
    // Clicking someone's stream starts watching it (Discord), straight into focus.
    if (id.endsWith(':screen') && pid !== 'local' && !engine.watching.has(pid)) {
      watchStream(pid, id);
      return;
    }
    if (currentViewMode === 'spotlight' && activeSpotlightId === id) {
      switchViewMode('grid');
      return;
    }
    activeSpotlightId = id;
    pinnedSpotlight = true;
    if (currentViewMode === 'grid') switchViewMode('spotlight');
    else renderStage();
  };
  card.addEventListener('click', focus);
  card.addEventListener('keydown', (e) => {
    if (e.target !== card) return; // buttons inside the card handle their own keys
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      focus();
    }
  });
  card.addEventListener('contextmenu', (e) => openContextMenu(e, pid, id));

  // Long press opens the menu on touch screens
  let touchTimer = null;
  card.addEventListener('touchstart', (e) => {
    const touch = e.touches[0];
    touchTimer = setTimeout(() => {
      openContextMenu({ preventDefault() {}, clientX: touch.clientX, clientY: touch.clientY }, pid, id);
    }, 500);
  }, { passive: true });
  const cancel = () => clearTimeout(touchTimer);
  card.addEventListener('touchend', cancel);
  card.addEventListener('touchmove', cancel);
  return card;
}

// Which kind of device each person is on, right of their name (desktop app, browser, phone).
const DEVICE_LABEL = { desktop: 'computador (app)', browser: 'navegador', mobile: 'celular' };
const DEVICE_ICONS = {
  desktop: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-6v2h3v2H7v-2h3v-2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v9h16V6H4z"/></svg>',
  browser: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.9 6h-2.9a15.7 15.7 0 0 0-1.4-3.6A8 8 0 0 1 18.9 8zM12 4c.8 1.2 1.5 2.5 1.9 4h-3.8c.4-1.5 1.1-2.8 1.9-4zM4.3 14a8.2 8.2 0 0 1 0-4h3.4a16.5 16.5 0 0 0 0 4H4.3zm.8 2h2.9c.3 1.3.8 2.5 1.4 3.6A8 8 0 0 1 5.1 16zM8 8H5.1a8 8 0 0 1 4.3-3.6C8.8 5.5 8.3 6.7 8 8zm4 12c-.8-1.2-1.5-2.5-1.9-4h3.8c-.4 1.5-1.1 2.8-1.9 4zm2.3-6H9.7a14.7 14.7 0 0 1 0-4h4.6a14.7 14.7 0 0 1 0 4zm.3 5.6c.6-1.1 1.1-2.3 1.4-3.6h2.9a8 8 0 0 1-4.3 3.6zm1.7-5.6a16.5 16.5 0 0 0 0-4h3.4a8.2 8.2 0 0 1 0 4h-3.4z"/></svg>',
  mobile: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm0 3v13h8V5H8zm3 14.2v1h2v-1h-2z"/></svg>'
};
function renderDeviceIcon(nameEl, device) {
  if (!nameEl) return;
  let icon = nameEl.nextElementSibling;
  if (!icon?.classList.contains('device-icon')) {
    icon = document.createElement('span');
    icon.className = 'device-icon';
    nameEl.after(icon);
  }
  const kind = DEVICE_ICONS[device] ? device : '';
  if (icon.dataset.device === kind) return;
  icon.dataset.device = kind;
  icon.innerHTML = kind ? DEVICE_ICONS[kind] : '';
  icon.classList.toggle('hidden', !kind);
  icon.title = kind ? tr(`No ${DEVICE_LABEL[kind]}`) : '';
}

function updateParticipantCard(card, p) {
  const label = `${p.name}${p.isLocal ? ' (Você)' : ''}`;
  card.title = p.isLocal ? label : `${label} · clique direito para volume e opções`;
  card.setAttribute('aria-label', `${label}${p.isStreaming ? ', transmitindo' : ''}`);
  card.classList.toggle('is-streaming', p.isStreaming);
  card.classList.toggle('is-speaking', !!p.speaking);

  const avatarBox = card.querySelector('.grid-card-avatar-content');
  const main = mainVideoOf(p);
  syncVideo(card, 'main-video', main.stream, { mirror: main.mirror });
  card.classList.toggle('has-camera', main.kind === 'camera');
  if (main.stream) {
    avatarBox.classList.add('hidden');
  } else {
    avatarBox.classList.remove('hidden');
    avatarBox.style.backgroundColor = cardColor(p);
    const img = avatarBox.querySelector('img');
    if (img.getAttribute('src') !== p.avatarUrl) img.src = p.avatarUrl;
  }

  renderStreamCover(card.querySelector('.stream-cover'), p);
  card.querySelector('.live-dot').classList.toggle('hidden', !p.isStreaming);
  card.querySelector('.nametag-text').textContent = label;
  card.querySelector('.nametag-text').style.color = p.nameColor || '';
  renderDeviceIcon(card.querySelector('.nametag-text'), p.device);
  renderVoiceIcons(card.querySelector('.voice-icons'), p);
  renderSignal(card.querySelector('.signal'), p);
  const state = card.querySelector('.peer-state');
  const stateText = p.status === 'connecting' ? 'conectando' : p.status === 'reconnecting' ? 'reconectando' : p.status === 'failed' ? 'sem conexão' : '';
  state.textContent = stateText;
  state.classList.toggle('hidden', !stateText);
}

// --------------------------------------------------------------------------
// Watching streams (Discord-style): "Assistir transmissão" and who is watching
// --------------------------------------------------------------------------

function watchStream(pid, tileId = `${pid}:screen`) {
  if (!pid || pid === 'local') return;
  resumeAudio();
  engine.setWatching(pid, true);
  activeSpotlightId = tileId;
  pinnedSpotlight = true;
  if (currentViewMode === 'grid') switchViewMode('spotlight');
  else renderStage();
}

// Discord: when a stream you watch in focus ends, its card stays focused, black, with
// "Essa transmissão acabou." for 2 minutes. You keep "watching" it meanwhile: if the person
// streams again, it plays by itself. Only "Fechar", the red button or the 2 minutes end it.
const STREAM_ENDED_MS = 2 * 60 * 1000;
// The own-stream preview pauses / resumes with the window focus.
for (const ev of ['focus', 'blur']) window.addEventListener(ev, () => scheduleRender());
document.addEventListener('visibilitychange', () => scheduleRender());

// While paused, the frozen frame is refreshed every 15 seconds: play until one new frame shows.
const PAUSED_FRAME_MS = 15000;
function previewVideos() {
  return document.querySelectorAll('#stage-grid-view video, #stage-spotlight-view video, video.strip-video');
}
setInterval(() => {
  if (!pausedStreams.size) return;
  for (const video of previewVideos()) {
    if (!video.srcObject || !pausedStreams.has(video.srcObject) || !video.paused) continue;
    const freeze = () => { if (pausedStreams.has(video.srcObject)) video.pause(); };
    video.play().then(() => {
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(freeze);
      else setTimeout(freeze, 150);
    }).catch(() => {});
  }
}, PAUSED_FRAME_MS);

function checkEndedStreams() {
  const live = new Set();
  for (const p of engine.peers.values()) if (p.isStreaming && engine.watching.has(p.id)) live.add(p.id);
  for (const pid of watchedLive) {
    const peer = engine.peers.get(pid);
    if (live.has(pid) || !peer || peer.isStreaming) continue;
    if (currentViewMode === 'spotlight' && activeSpotlightId === `${pid}:screen`) {
      endedStreams.set(pid, setTimeout(() => closeEndedStream(pid), STREAM_ENDED_MS));
    }
  }
  watchedLive = live;
  for (const pid of [...endedStreams.keys()]) {
    const peer = engine.peers.get(pid);
    if (!peer) { clearEndedStream(pid); continue; }
    if (peer.isStreaming) {
      // Back on air within the 2 minutes: still "watching", so it plays straight away.
      clearEndedStream(pid);
      watchedLive.add(pid);
      engine.setWatching(pid, true);
    }
  }
}
function clearEndedStream(pid) {
  clearTimeout(endedStreams.get(pid));
  endedStreams.delete(pid);
}
function clearAllEndedStreams() {
  for (const pid of [...endedStreams.keys()]) clearEndedStream(pid);
  watchedLive = new Set();
}
function closeEndedStream(pid) {
  if (!endedStreams.has(pid)) return;
  stopWatching(pid);
}
// Black cover with the message and "Fechar" on an ended stream card.
function renderStreamEnded(el, tile) {
  if (!el) return;
  el.classList.toggle('hidden', !tile.ended && !tile.previewPaused);
  el.classList.toggle('is-paused', !!tile.previewPaused);
}
function createStreamEnded(getPid) {
  const el = document.createElement('div');
  el.className = 'stream-ended hidden';
  el.innerHTML = '<p class="ended-text">Essa transmissão acabou.</p><button type="button" class="watch-stream-btn">Fechar</button>'
    + '<p class="paused-text">Sua transmissão ainda está ligada!</p><small class="paused-text">Nós pausamos esta prévia para preservar seus recursos.</small>';
  el.addEventListener('click', (e) => e.stopPropagation());
  el.querySelector('button').addEventListener('click', () => closeEndedStream(getPid()));
  return el;
}

function stopWatching(pid) {
  clearEndedStream(pid);
  engine.setWatching(pid, false);
  // The stream leaves focus too: back to the grid, nothing pinned.
  if (activeSpotlightId === `${pid}:screen`) {
    activeSpotlightId = null;
    pinnedSpotlight = false;
    if (currentViewMode === 'spotlight') {
      switchViewMode('grid');
      return;
    }
  }
  scheduleRender();
}

// Still frame of a stream we don't watch, behind the "Assistir transmissão" button.
function renderStreamCover(cover, tile) {
  if (!cover) return;
  const connecting = !tile.unwatched && !!tile.connecting;
  cover.classList.toggle('hidden', !tile.unwatched && !connecting);
  cover.classList.toggle('is-connecting', connecting);
  const image = (tile.unwatched || connecting) && tile.preview ? tile.preview : '';
  if (cover.dataset.image !== String(image.length) + image.slice(-24)) {
    cover.dataset.image = String(image.length) + image.slice(-24);
    cover.style.backgroundImage = image ? `url("${image}")` : '';
    cover.classList.toggle('has-preview', !!image);
  }
}

// Everyone watching a stream: your own, or someone else's (you included).
function viewersOf(pid) {
  const viewers = [];
  if (pid === 'local') {
    for (const p of engine.peers.values()) if (p.watching.has(engine.myPeerId)) viewers.push(p);
    return viewers;
  }
  if (engine.watching.has(pid)) viewers.push({ id: 'local', name: myNickname, avatarUrl: currentUser?.avatarUrl });
  for (const p of engine.peers.values()) if (p.id !== pid && p.watching.has(pid)) viewers.push(p);
  return viewers;
}

function renderViewers(el, tile) {
  if (!el) return;
  const viewers = tile.kind === 'screen' ? viewersOf(tile.pid) : [];
  el.classList.toggle('hidden', !viewers.length);
  const key = viewers.map(v => `${v.id}|${v.avatarUrl || ''}`).join(',');
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  const shown = viewers.slice(0, 4);
  el.replaceChildren(...shown.map((v) => {
    const img = document.createElement('img');
    img.className = 'viewer-avatar';
    img.alt = '';
    img.src = safeAvatar(v.avatarUrl);
    img.dataset.pid = v.id;
    return img;
  }));
  if (viewers.length > shown.length) {
    const more = document.createElement('span');
    more.className = 'viewer-more';
    more.textContent = `+${viewers.length - shown.length}`;
    el.append(more);
  }
  const names = viewers.map(v => (v.id === 'local' ? `${v.name} (Você)` : v.name));
  el.title = `Assistindo: ${names.join(', ')}`;
  el.setAttribute('aria-label', el.title);
}

// Discord: the focused stream's quality, "AO VIVO" and who watches it sit at the top right.
function renderHeaderLive(tile) {
  const show = currentViewMode === 'spotlight' && tile?.kind === 'screen';
  headerLive?.classList.toggle('hidden', !show);
  if (show && headerLiveQuality) {
    const h = !tile.unwatched && spotlightVideo.videoHeight;
    const fps = tile.isLocal ? engine.shareSettings.fps : 0;
    headerLiveQuality.textContent = h ? `${h}p${fps ? ` ${fps}FPS` : ''}` : '';
    headerLiveQuality.classList.toggle('hidden', !h);
  }
  renderViewers(headerViewers, show ? tile : { kind: 'none' });
}

// What fills a card: its own source (screen or camera), or nothing for an avatar card.
function mainVideoOf(tile) {
  if (!tile.mainStream) return { stream: null, kind: null, mirror: false };
  return { stream: tile.mainStream, kind: tile.kind, mirror: tile.mirror };
}

// Keeps one <video class="className"> in `container` playing `stream`, or removes it.
function syncVideo(container, className, stream, { mirror = false, prepend = true } = {}) {
  let video = container.querySelector(`video.${className}`);
  if (!stream) {
    if (video) {
      video.srcObject = null;
      video.remove();
    }
    return null;
  }
  if (!video) {
    video = document.createElement('video');
    video.className = className;
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    if (className === 'main-video') {
      // Follow the stream's intrinsic resolution changes, avoiding recursive element-resize loops
      video.addEventListener('resize', onVideoResolutionChange);
      video.addEventListener('loadedmetadata', onVideoResolutionChange);
    }
    if (prepend) container.prepend(video);
    else container.append(video);
  }
  // Your own camera is mirrored for you, like a mirror (others see it the right way round).
  video.classList.toggle('mirror', mirror);
  attachVideo(video, stream);
  return video;
}

function videoAspect(video) {
  return video && video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
}

// Any intrinsic size change re-runs layout; layout itself only writes when the size really changes.
function onVideoResolutionChange() {
  scheduleLayout();
}

// Fits a box of the given aspect ratio inside maxW × maxH.
function fitBox(aspect, maxW, maxH) {
  return aspect >= maxW / maxH
    ? { width: maxW, height: maxW / aspect }
    : { width: maxH * aspect, height: maxH };
}

function setSize(el, { width, height }) {
  const w = `${Math.floor(width)}px`;
  const h = `${Math.floor(height)}px`;
  if (el.style.width !== w) el.style.width = w;
  if (el.style.height !== h) el.style.height = h;
}

let layoutQueued = false;
function scheduleLayout() {
  if (layoutQueued) return;
  layoutQueued = true;
  requestAnimationFrame(() => {
    layoutQueued = false;
    layoutGrid();
    fitSpotlight();
  });
}

let lastGridKey = '';

// Smallest card before the grid starts scrolling. Below ~200px the cards switch to a compact
// look (smaller name tag, a dot for "conectando"), see the @container rules in style.css.
const GRID_MIN_TILE = 150;
const GRID_MIN_TILE_LANDSCAPE = 120;

// Cards that show a picture (screen or camera) and get the full width on portrait phones.
const isVideoCard = (card) => card.dataset.id.endsWith(':screen') || card.classList.contains('has-camera');

// Picks the column count that gives the largest 16:9 cells inside the stage. When even the
// smallest readable cards don't fit, the grid scrolls, sized to show whole rows only.
function layoutGrid() {
  if (!stageGridView || stageGridView.classList.contains('hidden')) return;
  const cards = [...stageGridView.children];
  const count = cards.length;
  if (!count) return;
  const gap = parseFloat(getComputedStyle(stageGridView).columnGap) || 16;
  const width = stageGridView.clientWidth;
  // Measured on the stage (not the grid): the grid's own height is set below.
  const stage = stageGridView.parentElement;
  const stageStyle = getComputedStyle(stage);
  const height = stage.clientHeight - parseFloat(stageStyle.paddingTop) - parseFloat(stageStyle.paddingBottom);
  if (!width || height <= 0) return;

  let cols;
  let tileW;
  let gridHeight = '';
  let mixed = false; // portrait phones: video cards span both columns

  if (narrowPhone.matches) {
    if (count <= 4) {
      cols = 1;
      tileW = width;
    } else {
      // Discord mobile: people two per row, screens and cameras across the whole width.
      cols = 2;
      tileW = (width - gap) / 2;
      mixed = true;
    }
  } else {
    let best = { cols: 1, tileWidth: 0 };
    for (let c = 1; c <= count; c++) {
      const rows = Math.ceil(count / c);
      const maxW = (width - gap * (c - 1)) / c;
      const maxH = (height - gap * (rows - 1)) / rows;
      const tileWidth = Math.min(maxW, maxH * 16 / 9);
      if (tileWidth > best.tileWidth) best = { cols: c, tileWidth };
    }
    const minTile = Math.min(width, landscapePhone.matches ? GRID_MIN_TILE_LANDSCAPE : GRID_MIN_TILE);
    if (best.tileWidth >= minTile) {
      cols = best.cols;
      tileW = best.tileWidth;
    } else {
      // Too many to fit: as many columns of readable cards as the width allows, and the grid
      // is cut to a whole number of rows so no card shows half under the dock.
      cols = Math.max(1, Math.floor((width + gap) / (minTile + gap)));
      tileW = Math.min((width - gap * (cols - 1)) / cols, minTile * 1.25);
      const cellH = Math.floor(tileW * 9 / 16);
      const rows = Math.max(1, Math.floor((height + gap) / (cellH + gap)));
      gridHeight = `${rows * cellH + (rows - 1) * gap}px`;
    }
  }

  tileW = Math.floor(tileW);
  const cellH = Math.floor(tileW * 9 / 16);
  const key = `${cols}|${tileW}|${gridHeight}|${mixed}`;
  if (key !== lastGridKey) {
    lastGridKey = key;
    stageGridView.style.setProperty('--grid-cols', cols);
    stageGridView.style.setProperty('--tile-width', `${tileW}px`);
    stageGridView.style.setProperty('--tile-height', mixed ? 'auto' : `${cellH}px`);
    stageGridView.style.height = gridHeight;
    // Snapping only where the grid shows whole rows (computers); on phones heights are mixed.
    stageGridView.classList.toggle('snap-rows', !!gridHeight);
  }

  const fullW = cols * tileW + (cols - 1) * gap; // exactly the tracks a spanning card covers
  // An incomplete last row is centered (e.g. 5 cards in 2 columns: the 5th sits in the middle).
  // Phones (mixed): video cards span the row, so only the avatars at the end can be unpaired.
  const leftover = mixed ? cards.filter(c => !isVideoCard(c)).length % 2 : count % cols;
  const shift = leftover ? Math.round((cols - leftover) * (tileW + gap) / 2) : 0;
  cards.forEach((card, i) => {
    const translate = shift && i >= count - leftover ? `${shift}px 0` : '';
    if (card.style.translate !== translate) card.style.translate = translate;
  });
  for (const card of cards) {
    // Grid cards are all the same 16:9 size; the video letterboxes inside with black bars.
    // Only the focused card takes the source's exact shape (see fitSpotlight).
    const wide = mixed && isVideoCard(card);
    const span = wide ? 'span 2' : '';
    if (card.style.gridColumn !== span) card.style.gridColumn = span;
    setSize(card, wide ? { width: fullW, height: Math.floor(fullW * 9 / 16) } : { width: tileW, height: cellH });
  }
  updateScrollFades(stageGridView);
}

// Soft fade on the edges of a scrolling list that has more to show in that direction.
function updateScrollFades(el) {
  if (!el) return;
  const vertical = el.scrollHeight > el.clientHeight + 2;
  const horizontal = el.scrollWidth > el.clientWidth + 2;
  el.classList.toggle('fade-top', vertical && el.scrollTop > 2);
  el.classList.toggle('fade-bottom', vertical && el.scrollTop + el.clientHeight < el.scrollHeight - 2);
  el.classList.toggle('fade-left', horizontal && el.scrollLeft > 2);
  el.classList.toggle('fade-right', horizontal && el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
}
stageGridView?.addEventListener('scroll', () => updateScrollFades(stageGridView), { passive: true });

// Layout modes that must match the media queries in style.css (sections 11 and 12).
const portraitPhone = matchMedia('(max-width: 900px) and (orientation: portrait)');
const landscapePhone = matchMedia('(max-height: 500px) and (orientation: landscape)');
const narrowPhone = matchMedia('(max-width: 600px) and (orientation: portrait)');
for (const query of [portraitPhone, landscapePhone, narrowPhone]) query.addEventListener?.('change', scheduleLayout);

// The focused card gets an explicit pixel size: the video's current aspect ratio fitted into the
// free space above the strip. Computed from the live video every time, so it can never keep a
// previous source's shape (CSS aspect-ratio + flex left it stale in some layouts).
function fitSpotlight() {
  if (!spotlightMainCard || !stageSpotlightView || stageSpotlightView.classList.contains('hidden')) return;
  syncStripCollapsed();
  updateImmersive();
  const streaming = !spotlightVideo.classList.contains('hidden');
  const aspect = streaming ? videoAspect(spotlightVideo) : 16 / 9;
  const stripShown = participantsStrip && getComputedStyle(participantsStrip).display !== 'none';
  const viewStyle = getComputedStyle(stageSpotlightView);
  const gap = stripShown ? parseFloat(viewStyle.rowGap) || 0 : 0;
  let maxW = stageSpotlightView.clientWidth;
  // Collapsed strip: the view keeps a little room at the bottom for the button that brings it back.
  const roomH = stageSpotlightView.clientHeight - parseFloat(viewStyle.paddingBottom || 0);
  let maxH;
  if (landscapePhone.matches && stripShown) {
    // Landscape phones: participants sit in a column to the right of the screen.
    maxW -= participantsStrip.offsetWidth + gap;
    maxH = roomH;
  } else if (portraitPhone.matches && stripShown) {
    // Phones in portrait: the participant grid below is flexible, so the screen takes the full
    // width and at most 60% of the height; the grid fills the rest.
    maxH = roomH * 0.6;
  } else {
    maxH = roomH - (stripShown ? participantsStrip.offsetHeight : 0) - gap;
  }
  if (maxW <= 0 || maxH <= 0) return;
  // setSize only writes when the rounded size changes, so this is cheap to call often.
  const size = fitBox(aspect, maxW, maxH);
  setSize(spotlightMainCard, size);

  // Portrait phones and tablets: one full-width column when everyone fits, two columns for a
  // few people, and more (smaller) columns for a crowd so it doesn't take a page per four people.
  if (participantsStrip) {
    let columns = '';
    if (portraitPhone.matches && !landscapePhone.matches && stripShown) {
      const count = participantsStrip.children.length;
      const free = roomH - Math.floor(size.height) - gap;
      const oneColumnHeight = count * (maxW * 9 / 16) + (count - 1) * 8;
      if (oneColumnHeight <= free) columns = '1fr';
      else if (count <= 6) columns = 'repeat(2, minmax(0, 1fr))';
      else {
        const minCard = maxW < 600 ? 110 : 170;
        const n = Math.max(2, Math.min(4, Math.floor((maxW + 8) / (minCard + 8))));
        columns = `repeat(${n}, minmax(0, 1fr))`;
      }
    }
    if (participantsStrip.style.gridTemplateColumns !== columns) participantsStrip.style.gridTemplateColumns = columns;
  }
  updateStripChrome();
}

// --------------------------------------------------------------------------
// Strip under the focused card: arrows + wheel when it overflows, fades on the edges, and a
// button to hide it (Discord's "hide members") so the screen gets the room. Saved per browser.
// --------------------------------------------------------------------------
const STRIP_COLLAPSED_KEY = 'kscreen.stripCollapsed';
let stripCollapsed = (() => { try { return localStorage.getItem(STRIP_COLLAPSED_KEY) === '1'; } catch { return false; } })();
const CHEVRON_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';

const stripArrows = ['left', 'right'].map((side) => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `strip-arrow strip-arrow-${side} hidden`;
  btn.setAttribute('aria-label', side === 'left' ? 'Ver anteriores' : 'Ver mais');
  btn.innerHTML = CHEVRON_SVG;
  btn.addEventListener('click', () => {
    participantsStrip.scrollBy({ left: (side === 'left' ? -1 : 1) * participantsStrip.clientWidth * 0.8, behavior: 'smooth' });
  });
  stageSpotlightView?.append(btn);
  return btn;
});

const stripToggle = document.createElement('button');
stripToggle.type = 'button';
stripToggle.className = 'strip-toggle hidden';
stripToggle.innerHTML = `${CHEVRON_SVG}<span class="strip-toggle-count"></span>`;
stripToggle.addEventListener('click', () => {
  stripCollapsed = !stripCollapsed;
  try { localStorage.setItem(STRIP_COLLAPSED_KEY, stripCollapsed ? '1' : '0'); } catch { /* private mode */ }
  scheduleLayout();
});
stageSpotlightView?.append(stripToggle);

// The strip runs in a row (computers) unless a phone layout turns it into a grid or a column.
const stripIsRow = () => !portraitPhone.matches && !landscapePhone.matches;
const stripHasCards = () => !!participantsStrip?.children.length;

// Collapsing only exists where the strip sits under the screen (not the landscape side column).
// Runs before the screen is measured: the button's presence changes the gap it sits in.
function syncStripCollapsed() {
  const hasCards = stripHasCards();
  const collapsed = stripCollapsed && hasCards && !landscapePhone.matches;
  stageSpotlightView.classList.toggle('strip-collapsed', collapsed);
  stripToggle.classList.toggle('hidden', !hasCards || landscapePhone.matches);
}

function updateStripChrome() {
  if (!participantsStrip || !stageSpotlightView) return;
  const hasCards = stripHasCards();
  const collapsed = stageSpotlightView.classList.contains('strip-collapsed');
  const count = participantsStrip.children.length;

  stripToggle.classList.toggle('collapsed', collapsed);
  stripToggle.querySelector('.strip-toggle-count').textContent = collapsed ? `${count}` : '';
  stripToggle.setAttribute('aria-expanded', String(!collapsed));
  stripToggle.title = collapsed ? 'Mostrar participantes' : 'Esconder participantes';
  stripToggle.setAttribute('aria-label', stripToggle.title);
  const viewStyle = getComputedStyle(stageSpotlightView);
  if (collapsed) {
    // Centered in the room kept free under the screen.
    const pad = parseFloat(viewStyle.paddingBottom) || 0;
    stripToggle.style.top = `${Math.round(stageSpotlightView.clientHeight - pad / 2 - stripToggle.offsetHeight / 2)}px`;
  } else if (hasCards) {
    // Centered in the seam between the screen and the strip (the gap is sized for it in CSS).
    const gap = parseFloat(viewStyle.rowGap) || 0;
    stripToggle.style.top = `${Math.round(participantsStrip.offsetTop - gap / 2 - stripToggle.offsetHeight / 2)}px`;
  }

  updateScrollFades(participantsStrip);
  const row = hasCards && !collapsed && stripIsRow();
  const s = participantsStrip;
  const overflow = row && s.scrollWidth > s.clientWidth + 2;
  const [left, right] = stripArrows;
  left.classList.toggle('hidden', !overflow || s.scrollLeft <= 2);
  right.classList.toggle('hidden', !overflow || s.scrollLeft + s.clientWidth >= s.scrollWidth - 2);
  if (overflow) {
    const top = `${s.offsetTop + s.offsetHeight / 2 - left.offsetHeight / 2}px`;
    left.style.top = top;
    right.style.top = top;
    left.style.left = `${s.offsetLeft + 6}px`;
    right.style.left = `${s.offsetLeft + s.offsetWidth - right.offsetWidth - 6}px`;
  }
}

participantsStrip?.addEventListener('scroll', () => updateStripChrome(), { passive: true });
// A mouse wheel only scrolls up/down: turn it sideways while the strip is a row that overflows.
participantsStrip?.addEventListener('wheel', (e) => {
  if (!stripIsRow() || Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.ctrlKey) return;
  const s = participantsStrip;
  if (s.scrollWidth <= s.clientWidth + 2) return;
  s.scrollLeft += e.deltaY;
  e.preventDefault();
}, { passive: false });

// Same cover and viewer avatars as the grid cards.
const spotlightCover = document.createElement('div');
spotlightCover.className = 'stream-cover hidden';
spotlightCover.innerHTML = `<button type="button" class="watch-stream-btn">Assistir transmissão</button>${spinnerHtml()}`;
spotlightCover.querySelector('button').addEventListener('click', (e) => {
  e.stopPropagation();
  watchStream(spotlightMainCard.dataset.pid, spotlightMainCard.dataset.id);
});
const headerViewers = $('header-viewers');
const headerLive = $('header-live');
const headerLiveQuality = $('header-live-quality');
spotlightMainCard?.append(spotlightCover);
const spotlightEnded = createStreamEnded(() => spotlightMainCard.dataset.pid);
spotlightMainCard?.append(spotlightEnded);

spotlightVideo?.addEventListener('resize', onVideoResolutionChange);
spotlightVideo?.addEventListener('loadedmetadata', onVideoResolutionChange);
spotlightVideo?.addEventListener('playing', onVideoResolutionChange);
window.addEventListener('resize', scheduleLayout);
if ('ResizeObserver' in window && stageSpotlightView) {
  // Observes the container, not the card, so resizing the card can't feed back into itself.
  new ResizeObserver(scheduleLayout).observe(stageSpotlightView);
}
// Safety net: re-check once a second while a screen is focused.
setInterval(() => {
  if (!document.hidden && currentViewMode === 'spotlight') fitSpotlight();
}, 1000);

// --------------------------------------------------------------------------
// 2. SPOTLIGHT VIEW
// --------------------------------------------------------------------------

function renderSpotlightView(participants) {
  const focused = participants.find(p => p.id === activeSpotlightId) || participants[0];

  const main = mainVideoOf(focused);
  const streaming = main.kind === 'screen';
  if (spotlightMainCard.dataset.id !== focused.id || spotlightVideo.srcObject !== main.stream) {
    resetZoom();
  }
  spotlightVideo.classList.toggle('mirror', main.mirror);
  spotlightMainCard.classList.toggle('has-camera', main.kind === 'camera');
  if (main.stream) {
    spotlightVideo.classList.remove('hidden');
    spotlightAvatarFallback?.classList.add('hidden');
    attachVideo(spotlightVideo, main.stream);
  } else {
    spotlightVideo.srcObject = null;
    spotlightVideo.classList.add('hidden');
    spotlightAvatarFallback?.classList.remove('hidden');
    // Same color card as in the grid: just their color and avatar.
    if (spotlightAvatarFallback) spotlightAvatarFallback.style.backgroundColor = cardColor(focused);
    if (spotlightFallbackAvatar && spotlightFallbackAvatar.getAttribute('src') !== focused.avatarUrl) {
      spotlightFallbackAvatar.src = focused.avatarUrl;
    }
  }

  try { paintZoomSlider(); } catch { /* runs before the zoom control is set up */ }
  renderStreamCover(spotlightCover, focused);
  renderStreamEnded(spotlightEnded, focused);
  renderHeaderLive(streaming || focused.kind === 'screen' ? focused : null);
  if (spotlightNametagText) {
    spotlightNametagText.textContent = `${focused.name}${focused.isLocal ? ' (Você)' : ''}`;
    spotlightNametagText.style.color = focused.nameColor || '';
    renderDeviceIcon(spotlightNametagText, focused.device);
  }
  spotlightLiveDot?.classList.toggle('hidden', !focused.isStreaming);
  renderVoiceIcons(spotlightVoiceIcons, focused);
  renderSignal(spotlightSignal, focused);
  spotlightMainCard.classList.toggle('is-speaking', !!focused.speaking);
  spotlightMainCard.classList.toggle('is-streaming', streaming);
  spotlightMainCard.dataset.id = focused.id;
  spotlightMainCard.dataset.pid = focused.pid;
  // The card shown big is left out of the strip (no duplicate below it). If that was the
  // person's only card (screen without camera), they stay listed with their photo.
  const stripTiles = participants.filter(p => p.id !== focused.id);
  if (!stripTiles.some(t => t.pid === focused.pid)) {
    const index = stripTiles.filter(t => t.kind === 'screen').length; // after the streams
    stripTiles.splice(index, 0, {
      ...focused,
      id: `${focused.pid}:user`,
      kind: 'avatar',
      mainStream: null,
      mirror: false,
      isStreaming: false
    });
  }
  renderParticipantsStrip(stripTiles);
  fitSpotlight();
}

function renderParticipantsStrip(participants) {
  if (!participantsStrip) return;
  const ids = new Set(participants.map(p => p.id));
  for (const card of [...participantsStrip.children]) {
    if (!ids.has(card.dataset.id)) card.remove();
  }

  participants.forEach((p, index) => {
    let card = participantsStrip.querySelector(`[data-id="${CSS.escape(p.id)}"]`);
    if (!card) {
      card = createParticipantCard(p.id, 'strip-participant-card', p.pid);
      card.innerHTML = `
        <img class="strip-avatar-circle" alt="" />
        <button type="button" class="watch-stream-btn strip-watch-btn hidden">Assistir transmissão</button>
        <div class="strip-nametag"><span class="live-dot hidden"></span><span class="nametag-text"></span><span class="voice-icons"></span></div>`;
    }
    if (!card.dataset.wired) {
      card.dataset.wired = '1';
      card.querySelector('.strip-watch-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        watchStream(card.dataset.pid, card.dataset.id);
      });
      card.append(createStreamEnded(() => card.dataset.pid));
    }
    renderStreamEnded(card.querySelector('.stream-ended'), p);
    if (participantsStrip.children[index] !== card) participantsStrip.insertBefore(card, participantsStrip.children[index] || null);

    card.classList.toggle('active-spotlight', p.id === activeSpotlightId);
    card.classList.toggle('is-speaking', !!p.speaking);
    card.setAttribute('aria-pressed', String(p.id === activeSpotlightId));
    card.style.backgroundColor = cardColor(p);
    const img = card.querySelector('img');
    if (img.getAttribute('src') !== p.avatarUrl) img.src = p.avatarUrl;

    // Live thumbnail of the card's own source (screen or camera), or the avatar.
    const main = mainVideoOf(p);
    syncVideo(card, 'strip-video', main.stream, { mirror: main.mirror });
    card.classList.toggle('has-camera', main.kind === 'camera');
    card.classList.toggle('preview-paused', !!p.previewPaused);
    const still = p.unwatched && p.preview ? p.preview : '';
    if (card.dataset.still !== String(still.length) + still.slice(-24)) {
      card.dataset.still = String(still.length) + still.slice(-24);
      card.style.backgroundImage = still ? `url("${still}")` : '';
    }
    card.classList.toggle('has-still', !!still);
    card.classList.toggle('is-unwatched', !!p.unwatched);
    card.querySelector('.strip-watch-btn').classList.toggle('hidden', !p.unwatched);
    img.classList.toggle('hidden', !!main.stream || !!still || !!p.unwatched);

    card.querySelector('.live-dot').classList.toggle('hidden', !p.isStreaming);
    card.querySelector('.nametag-text').textContent = `${p.name}${p.isLocal ? ' (Você)' : ''}`;
    card.querySelector('.nametag-text').style.color = p.nameColor || '';
    renderDeviceIcon(card.querySelector('.nametag-text'), p.device);
    renderVoiceIcons(card.querySelector('.voice-icons'), p);
    card.title = `${p.name}${p.isStreaming ? ' · transmitindo' : ''}`;
    card.setAttribute('aria-label', `${p.name}${p.isLocal ? ' (Você)' : ''}${p.isStreaming ? ', transmitindo' : ''}`);
  });
}

// ==========================================================================
// VIEW MODE TOGGLER (GRID <-> SPOTLIGHT)
// ==========================================================================

function switchViewMode(mode) {
  currentViewMode = mode;
  const grid = mode === 'grid';
  iconViewGrid?.classList.toggle('hidden', !grid);
  iconViewSpotlight?.classList.toggle('hidden', grid);
  if (viewModeLabel) viewModeLabel.textContent = grid ? 'Grade' : 'Destaque';
  if (grid) pinnedSpotlight = false;
  renderStage();
  updateImmersive();
}

btnToggleView?.addEventListener('click', () => {
  switchViewMode(currentViewMode === 'grid' ? 'spotlight' : 'grid');
});

// --------------------------------------------------------------------------
// Fullscreen (Discord-style): ONE button for the whole call. Everything stays as it is
// (grid, focused card, members strip, dock) on a black, edge-to-edge screen. Focusing a card
// and hiding the members there gives "immersive" mode: the card fills the screen and the header
// and dock float over it, fading out while the mouse rests.
// --------------------------------------------------------------------------

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
    return;
  }
  const root = document.documentElement;
  if (root.requestFullscreen) root.requestFullscreen().catch(() => {});
  // iOS Safari only supports fullscreen on a <video> itself
  else if (currentViewMode === 'spotlight') spotlightVideo?.webkitEnterFullscreen?.();
}

// Fullscreen + focused card + members hidden (or nobody else to list).
function updateImmersive() {
  const on = document.body.classList.contains('stage-fullscreen') && currentViewMode === 'spotlight'
    && (stageSpotlightView?.classList.contains('strip-collapsed') || !participantsStrip?.children.length);
  if (document.body.classList.contains('stage-immersive') === on) return;
  document.body.classList.toggle('stage-immersive', on);
  wakeControls();
  scheduleLayout();
}

// Discord: the dock (and the buttons level with it) and the names on the cards fade out while
// the mouse rests or leaves the cards, leaving only each person's state (muted / deafened).
// In immersive view the header goes too. Touch screens have no hover: only immersive hides.
let idleTimer = null;
let pointerAway = false;
const noHover = window.matchMedia?.('(hover: none)');
const DOCK_ROW = () => [kennyyDockWrapper, btnStageFullscreen, $('stage-volume'), $('stage-zoom'), $('btn-room-settings')];

function canIdle() {
  if (!engine.activeRoomId) return false;
  return document.body.classList.contains('stage-immersive') || !noHover?.matches;
}

// Something the user is in the middle of keeps everything up.
function controlsBusy() {
  if (isShown(shareMenu) || isShown(deviceMenu) || isShown(videoContextMenu) || isShown($('room-code-menu'))) return true;
  if (document.body.classList.contains('settings-open')) return true;
  if (DOCK_ROW().some(el => el?.matches(':hover') || el?.matches(':focus-within'))) return true;
  if (stripToggle.matches(':hover')) return true;
  return document.body.classList.contains('stage-immersive') && !!kennyyTopbar?.matches(':hover');
}

function setControlsIdle(on) {
  document.body.classList.toggle('controls-idle', on);
}

function wakeControls() {
  clearTimeout(idleTimer);
  if (!canIdle()) { setControlsIdle(false); return; }
  if (pointerAway && !controlsBusy()) { setControlsIdle(true); return; }
  setControlsIdle(false);
  idleTimer = setTimeout(() => {
    if (controlsBusy()) return wakeControls();
    setControlsIdle(true);
  }, 2500);
}

// "The cards area": the stage and the dock row over it (by position: hidden controls don't
// take the pointer), minus the chat when it floats over the call.
function pointerInCards(x, y) {
  const inside = (el) => {
    if (!el || el.classList.contains('hidden')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };
  if (inside(document.querySelector('.chat-panel'))) return false;
  return inside(kennyyStage) || DOCK_ROW().some(inside) || (document.body.classList.contains('stage-immersive') && inside(kennyyTopbar));
}

document.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') { pointerAway = false; wakeControls(); return; }
  pointerAway = !pointerInCards(e.clientX, e.clientY);
  wakeControls();
}, { passive: true });
document.addEventListener('pointerdown', () => { pointerAway = false; wakeControls(); }, { passive: true });
// Leaving the window counts as leaving the cards.
document.documentElement.addEventListener('mouseleave', () => { pointerAway = true; wakeControls(); });
window.addEventListener('blur', () => { pointerAway = true; wakeControls(); });

document.addEventListener('fullscreenchange', () => {
  const on = document.fullscreenElement === document.documentElement;
  document.body.classList.toggle('stage-fullscreen', on);
  if (btnStageFullscreen) {
    btnStageFullscreen.title = on ? 'Sair da tela cheia' : 'Tela cheia';
    btnStageFullscreen.setAttribute('aria-label', btnStageFullscreen.title);
  }
  updateImmersive();
  wakeControls();
  scheduleLayout();
});
document.addEventListener('keydown', wakeControls);

btnStageFullscreen?.addEventListener('click', () => toggleFullscreen());

// Volume next to fullscreen (Discord): acts on the focused card — a stream's sound or a
// person's voice — and on the room's output volume when nothing remote is focused.
const stageVolume = $('stage-volume');
const stageVolumeSlider = $('stage-volume-slider');
const btnStageVolume = $('btn-stage-volume');

function stageVolumeTarget() {
  const [pid, kind] = String(activeSpotlightId || '').split(':');
  if (currentViewMode === 'spotlight' && pid && pid !== 'local' && engine.peers.has(pid)) {
    const stream = kind === 'screen';
    return { pid, kind: stream ? 'stream' : 'voice', label: tr(stream ? `Volume da transmissão de ${engine.peerName(pid)}` : `Volume de ${engine.peerName(pid)}`) };
  }
  return { pid: null, label: tr('Volume de saída') };
}

function paintStageVolume() {
  try { paintZoomSlider(); } catch { /* runs before the zoom control is set up */ }
  if (!stageVolume) return;
  const t = stageVolumeTarget();
  let value;
  let muted;
  if (t.pid) {
    const f = VOLUME_FIELDS[t.kind];
    const prefs = getAudioPrefs(t.pid);
    value = prefs[f.volume];
    muted = prefs[f.muted];
  } else {
    value = devicePrefs.outVolume;
    muted = value === 0;
  }
  stageVolumeSlider.value = muted ? 0 : value;
  stageVolumeSlider.style.setProperty('--fill', `${(muted ? 0 : value) / 2}%`);
  stageVolume.classList.toggle('muted', muted || value === 0);
  btnStageVolume.title = `${t.label}: ${muted ? 0 : value}%`;
  btnStageVolume.setAttribute('aria-label', btnStageVolume.title);
  stageVolumeSlider.setAttribute('aria-label', t.label);
}

let stageVolumeBeforeMute = 100;
stageVolumeSlider?.addEventListener('input', () => {
  const t = stageVolumeTarget();
  const v = parseInt(stageVolumeSlider.value, 10);
  if (t.pid) {
    const f = VOLUME_FIELDS[t.kind];
    saveAudioPrefs(t.pid, { [f.volume]: v, [f.muted]: false });
  } else {
    devicePrefs.outVolume = v;
    saveDevicePrefs();
  }
  refreshGains();
  paintStageVolume();
});
btnStageVolume?.addEventListener('click', () => {
  const t = stageVolumeTarget();
  if (t.pid) {
    const f = VOLUME_FIELDS[t.kind];
    saveAudioPrefs(t.pid, { [f.muted]: !getAudioPrefs(t.pid)[f.muted] });
  } else if (devicePrefs.outVolume > 0) {
    stageVolumeBeforeMute = devicePrefs.outVolume;
    devicePrefs.outVolume = 0;
    saveDevicePrefs();
  } else {
    devicePrefs.outVolume = stageVolumeBeforeMute || 100;
    saveDevicePrefs();
  }
  refreshGains();
  paintStageVolume();
});
stageVolume?.addEventListener('pointerenter', paintStageVolume);
stageVolume?.addEventListener('wheel', (e) => {
  e.preventDefault();
  stageVolumeSlider.value = Math.max(0, Math.min(200, Number(stageVolumeSlider.value) + (e.deltaY < 0 ? 5 : -5)));
  stageVolumeSlider.dispatchEvent(new Event('input'));
}, { passive: false });

// --------------------------------------------------------------------------
// Scroll to zoom into the focused screen, drag to pan (Discord-style)
// --------------------------------------------------------------------------

const zoom = { scale: 1, x: 0, y: 0 };
let dragState = null;
let suppressClick = false;

function applyZoom() {
  const { width, height } = spotlightMainCard.getBoundingClientRect();
  // Never let the zoomed picture leave an empty edge inside the card.
  zoom.x = Math.min(0, Math.max(width * (1 - zoom.scale), zoom.x));
  zoom.y = Math.min(0, Math.max(height * (1 - zoom.scale), zoom.y));
  spotlightVideo.style.transform = zoom.scale === 1 ? '' : `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
  spotlightMainCard.classList.toggle('is-zoomed', zoom.scale > 1);
  paintZoomSlider();
}

// Spyglass next to the volume: a horizontal slider (100-600%) zooming around the card's centre.
const stageZoom = $('stage-zoom');
const stageZoomSlider = $('stage-zoom-slider');
const btnStageZoom = $('btn-stage-zoom');

function zoomable() {
  return !!engine.activeRoomId && currentViewMode === 'spotlight' && spotlightVideo
    && !spotlightVideo.classList.contains('hidden') && !spotlightVideo.classList.contains('mirror');
}

function paintZoomSlider() {
  if (!stageZoom) return;
  stageZoom.classList.toggle('hidden', !zoomable());
  const pct = Math.round(zoom.scale * 100);
  stageZoomSlider.value = pct;
  stageZoomSlider.style.setProperty('--fill', `${(pct - 100) / 5}%`);
  stageZoom.classList.toggle('zoomed', zoom.scale > 1);
  btnStageZoom.title = `${tr('Zoom')}: ${pct}%`;
}

function setZoomScale(next, cx, cy) {
  const rect = spotlightMainCard.getBoundingClientRect();
  if (cx === undefined) { cx = rect.width / 2; cy = rect.height / 2; }
  next = Math.min(6, Math.max(1, next));
  zoom.x = cx - (cx - zoom.x) * (next / zoom.scale);
  zoom.y = cy - (cy - zoom.y) * (next / zoom.scale);
  zoom.scale = next < 1.01 ? 1 : next;
  if (zoom.scale === 1) resetZoom();
  else applyZoom();
}

stageZoomSlider?.addEventListener('input', () => setZoomScale(Number(stageZoomSlider.value) / 100));
btnStageZoom?.addEventListener('click', () => setZoomScale(zoom.scale > 1 ? 1 : 2));

function resetZoom() {
  zoom.scale = 1;
  zoom.x = 0;
  zoom.y = 0;
  if (spotlightVideo) spotlightVideo.style.transform = '';
  spotlightMainCard?.classList.remove('is-zoomed');
  try { paintZoomSlider(); } catch { /* runs before the zoom control is set up */ }
}

// The card changes size with the window (or the chat): keep the same part of the picture in
// view, scaled with the card, instead of an offset in pixels that no longer fits.
let zoomCardSize = null;
if (spotlightMainCard && 'ResizeObserver' in window) {
  new ResizeObserver(() => {
    const { width, height } = spotlightMainCard.getBoundingClientRect();
    const prev = zoomCardSize;
    zoomCardSize = { width, height };
    if (!prev || zoom.scale === 1 || !width || !height || !prev.width || !prev.height) return;
    zoom.x *= width / prev.width;
    zoom.y *= height / prev.height;
    applyZoom();
  }).observe(spotlightMainCard);
}

spotlightMainCard?.addEventListener('wheel', (e) => {
  // No zoom on hidden video or on your own mirrored camera
  if (spotlightVideo.classList.contains('hidden') || spotlightVideo.classList.contains('mirror')) return;
  e.preventDefault();
  const rect = spotlightMainCard.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  // Keep the point under the cursor fixed while zooming.
  setZoomScale(zoom.scale * Math.exp(-e.deltaY * 0.0015), cx, cy);
}, { passive: false });

spotlightMainCard?.addEventListener('pointerdown', (e) => {
  suppressClick = false;
  if (zoom.scale === 1 || e.button !== 0 || e.target.closest('button')) return;
  dragState = { id: e.pointerId, startX: e.clientX, startY: e.clientY, x: zoom.x, y: zoom.y };
  spotlightMainCard.setPointerCapture(e.pointerId);
});

spotlightMainCard?.addEventListener('pointermove', (e) => {
  if (!dragState || e.pointerId !== dragState.id) return;
  const dx = e.clientX - dragState.startX;
  const dy = e.clientY - dragState.startY;
  if (Math.abs(dx) + Math.abs(dy) > 4) suppressClick = true;
  zoom.x = dragState.x + dx;
  zoom.y = dragState.y + dy;
  applyZoom();
});

const endDrag = (e) => {
  if (dragState && e.pointerId === dragState.id) dragState = null;
};
spotlightMainCard?.addEventListener('pointerup', endDrag);
spotlightMainCard?.addEventListener('pointercancel', endDrag);

// Clicking the focused screen goes back to the grid (not after a pan, not in fullscreen).
// Discord: clicking the focused card goes back to the grid, and clicking a card in the grid
// focuses it again - in or out of fullscreen. With the members hidden, that focus is the card
// alone (immersive in fullscreen); with them shown, the card plus the members below.
spotlightMainCard?.addEventListener('click', (e) => {
  if (e.target.closest('button') || suppressClick) return;
  switchViewMode('grid');
});
spotlightMainCard?.addEventListener('contextmenu', (e) => openContextMenu(e, spotlightMainCard.dataset.pid, spotlightMainCard.dataset.id));

// ==========================================================================
// REMOTE AUDIO (0% to 200% per participant via Web Audio API)
// ==========================================================================

// Per person, like Discord: their voice (volume / muted) and their stream's sound
// (streamVolume / streamMuted) are adjusted separately.
const AUDIO_PREF_DEFAULTS = { volume: 100, muted: false, streamVolume: 100, streamMuted: false };
// Saved per Discord account, not per connection: peer ids are new on every join, so
// someone you muted stays muted when they (or you) come back. Old per-peer entries still load.
function audioPrefKey(peerId) {
  const userId = engine.roster.get(peerId)?.userId;
  return userId ? `u:${userId}` : peerId;
}

// One-time: the old "Desativar áudio" (micOff) becomes the speaker's mute, which does the same.
try {
  const all = JSON.parse(localStorage.getItem('kennyy_audio_prefs') || '{}');
  let changed = false;
  for (const prefs of Object.values(all)) {
    if (prefs && 'micOff' in prefs) {
      if (prefs.micOff) prefs.muted = true;
      delete prefs.micOff;
      changed = true;
    }
  }
  if (changed) localStorage.setItem('kennyy_audio_prefs', JSON.stringify(all));
} catch { /* storage blocked */ }

function getAudioPrefs(peerId) {
  try {
    const all = JSON.parse(localStorage.getItem('kennyy_audio_prefs') || '{}');
    return { ...AUDIO_PREF_DEFAULTS, ...(all[peerId] || {}), ...(all[audioPrefKey(peerId)] || {}) };
  } catch {
    return { ...AUDIO_PREF_DEFAULTS };
  }
}
// Which pref fields a volume control edits: the person's voice or their stream.
const VOLUME_FIELDS = {
  voice: { volume: 'volume', muted: 'muted' },
  stream: { volume: 'streamVolume', muted: 'streamMuted' }
};

function saveAudioPrefs(peerId, prefs) {
  try {
    const all = JSON.parse(localStorage.getItem('kennyy_audio_prefs') || '{}');
    const key = audioPrefKey(peerId);
    all[key] = { ...(all[peerId] || {}), ...(all[key] || {}), ...prefs };
    if (key !== peerId) delete all[peerId];
    localStorage.setItem('kennyy_audio_prefs', JSON.stringify(all));
  } catch { /* storage full or blocked */ }
}

function getAudioContext() {
  if (!audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    audioContext = new AudioContextClass();
    loadSounds(audioContext);
    audioContext.addEventListener('statechange', updateAudioUnlock);
    applyOutputDevice();
  }
  if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
  return audioContext;
}

// Browsers keep the AudioContext suspended until a user gesture. Someone who
// arrives through an invite link (often straight from the Discord login) may
// never click, so a visible button asks for that gesture.
const audioUnlockButton = document.createElement('button');
audioUnlockButton.type = 'button';
audioUnlockButton.className = 'audio-unlock hidden';
audioUnlockButton.textContent = '🔊 Clique para ativar o áudio da sala';
document.getElementById('app')?.append(audioUnlockButton);

function resumeAudio() {
  if (audioContext?.state === 'suspended') audioContext.resume().then(updateAudioUnlock).catch(() => {});
}

function updateAudioUnlock() {
  const blocked = audioContext?.state === 'suspended' && audioPipelines.size > 0 && !!engine.activeRoomId;
  audioUnlockButton.classList.toggle('hidden', !blocked);
}

audioUnlockButton.addEventListener('click', resumeAudio);
document.addEventListener('pointerdown', resumeAudio, { capture: true });
document.addEventListener('keydown', resumeAudio, { capture: true });

function gainFor(peerId, kind = 'voice') {
  const prefs = getAudioPrefs(peerId);
  const f = VOLUME_FIELDS[kind];
  // Deafen silences voices only: the audio of a stream you're watching keeps playing.
  return (prefs[f.muted] || (isAudioMuted && kind === 'voice')) ? 0 : (prefs[f.volume] / 100) * (devicePrefs.outVolume / 100);
}

// One pipeline per peer with two volume controls: the mic goes through `voice`, the stream's
// sound through `stream`, so each can be turned up or down on its own.
function syncAudio(participants) {
  const remote = participants.filter(p => !p.isLocal);
  const active = new Set();
  for (const p of remote) {
    // A stream's sound plays only while you watch it; the mic always plays.
    const tracks = p.audioStream?.getAudioTracks()
      .filter(t => t.readyState === 'live' && (p.watching || t !== p.screenAudioTrack)) || [];
    if (!tracks.length) continue;
    active.add(p.id);
    const key = tracks.map(t => t.id).join(',');
    let pipeline = audioPipelines.get(p.id);
    if (!pipeline || pipeline.key !== key) {
      removeAudioPipeline(p.id);
      const ctx = getAudioContext();
      if (!ctx) continue;
      const gains = { voice: ctx.createGain(), stream: ctx.createGain() };
      for (const g of Object.values(gains)) g.connect(ctx.destination);
      // One source per track: a MediaStreamAudioSourceNode only plays ONE track of
      // its stream, which silenced screen audio whenever the mic track was picked.
      const sources = tracks.map(track => {
        const stream = new MediaStream([track]);
        // Chrome only feeds remote WebRTC audio into Web Audio while a media element plays it.
        const element = new Audio();
        element.muted = true;
        element.srcObject = stream;
        element.play().catch(() => {});
        const source = ctx.createMediaStreamSource(stream);
        source.connect(track === p.screenAudioTrack ? gains.stream : gains.voice);
        return { element, source };
      });
      pipeline = { key, gains, sources };
      audioPipelines.set(p.id, pipeline);
    }
    setPipelineGains(p.id, pipeline);
  }
  for (const id of [...audioPipelines.keys()]) {
    if (!active.has(id)) removeAudioPipeline(id);
  }
  updateAudioUnlock();
}

function removeAudioPipeline(peerId) {
  const pipeline = audioPipelines.get(peerId);
  if (!pipeline) return;
  audioPipelines.delete(peerId);
  for (const { source, element } of pipeline.sources) {
    try { source.disconnect(); } catch { /* already disconnected */ }
    element.srcObject = null;
  }
  for (const g of Object.values(pipeline.gains)) {
    try { g.disconnect(); } catch { /* already disconnected */ }
  }
}

function setPipelineGains(peerId, pipeline) {
  pipeline.gains.voice.gain.value = gainFor(peerId, 'voice');
  pipeline.gains.stream.gain.value = gainFor(peerId, 'stream');
}

function refreshGains() {
  for (const [peerId, pipeline] of audioPipelines) setPipelineGains(peerId, pipeline);
  // Every volume control shows the same state (right-click menu, button next to fullscreen).
  try { paintStageVolume(); } catch { /* not set up yet */ }
}

// ==========================================================================
// CONTEXT MENU
// ==========================================================================

function findParticipant(id) {
  return getParticipantList().find(p => p.id === id);
}

// `id` is the person (volume and switches act on them); `tileId` the card that was clicked.
// The menu's volume edits the voice on a person's card and the stream's sound on their stream.
let contextMenuVolumeKind = 'voice';
function paintCtxVolume(prefs, kind = contextMenuVolumeKind) {
  const f = VOLUME_FIELDS[kind];
  const volume = prefs[f.volume];
  const muted = !!prefs[f.muted];
  ctxVolumeSlider.value = volume;
  ctxVolumeSlider.style.setProperty('--fill', `${muted ? 0 : volume / 2}%`);
  ctxBtnMute.setAttribute('aria-pressed', String(muted));
  ctxBtnMute.title = muted ? 'Ativar som' : 'Silenciar';
  ctxBtnMute.querySelector('.spk-on').classList.toggle('hidden', muted);
  ctxBtnMute.querySelector('.spk-off').classList.toggle('hidden', !muted);
}

// --------------------------------------------------------------------------
// Pop-out: a stream in a window of its own (public/popout.html). Same MediaStream, no new
// connection; sound keeps going through this window's audio pipeline. The card here shows
// "Aberta em outra janela" until it comes back (closing that window brings it back).
// --------------------------------------------------------------------------

const popouts = new Map(); // tileId -> { win, video, msg, timer }
let lastTiles = [];

function canPopOut(tileId) {
  const tile = lastTiles.find(t => t.id === tileId);
  return !!(tile && tile.kind === 'screen' && tile.mainStream);
}

function popOutTile(tileId) {
  const open = popouts.get(tileId);
  if (open && !open.win.closed) { open.win.focus(); return; }
  const tile = lastTiles.find(t => t.id === tileId);
  const video = tile && (tileId === spotlightMainCard?.dataset.id ? spotlightVideo
    : document.querySelector(`[data-id="${CSS.escape(tileId)}"] video.main-video`));
  const aspect = videoAspect(video);
  const width = Math.round(Math.min(1280, (window.screen?.availWidth || 1600) * 0.6));
  const height = Math.round(width / aspect);
  const win = window.open('/popout.html', `kscreen-popout-${tileId.replace(/[^\w-]/g, '-')}`,
    `popup,width=${width},height=${height}`);
  if (!win) {
    showToast('O navegador bloqueou a janela. Permita pop-ups para este site.');
    return;
  }
  const entry = { win, video: null, msg: null, timer: null };
  popouts.set(tileId, entry);
  // Wait for popout.html (not the initial about:blank) before filling it.
  let tries = 0;
  entry.timer = setInterval(() => {
    tries++;
    let doc = null;
    try { doc = !win.closed && win.location.pathname === '/popout.html' && win.document.readyState !== 'loading' ? win.document : null; } catch { /* not there yet */ }
    if (win.closed || tries > 100) {
      clearInterval(entry.timer);
      if (popouts.get(tileId) === entry) closePopout(tileId);
      return;
    }
    if (!doc || !doc.getElementById('popout-video')) return;
    clearInterval(entry.timer);
    entry.timer = null;
    entry.video = doc.getElementById('popout-video');
    entry.msg = doc.getElementById('popout-msg');
    entry.video.addEventListener('dblclick', () => {
      if (doc.fullscreenElement) doc.exitFullscreen().catch(() => {});
      else doc.documentElement.requestFullscreen?.().catch(() => {});
    });
    // Closing the window brings the stream back here.
    win.addEventListener('pagehide', () => { if (popouts.get(tileId) === entry) closePopout(tileId, { keepWindow: true }); });
    syncPopouts(lastTiles);
  }, 100);
  scheduleRender();
}

function closePopout(tileId, { keepWindow = false } = {}) {
  const entry = popouts.get(tileId);
  if (!entry) return;
  popouts.delete(tileId);
  clearInterval(entry.timer);
  try { if (entry.video) entry.video.srcObject = null; } catch { /* window gone */ }
  if (!keepWindow) try { entry.win.close(); } catch { /* already closed */ }
  scheduleRender();
}

function closeAllPopouts() {
  for (const id of [...popouts.keys()]) closePopout(id);
  syncPopouts([]);
}
window.addEventListener('pagehide', () => { for (const e of popouts.values()) try { e.win.close(); } catch { /* gone */ } });

function syncPopouts(tiles) {
  lastTiles = tiles;
  for (const [tileId, entry] of popouts) {
    if (entry.win.closed) { closePopout(tileId, { keepWindow: true }); continue; }
    if (!entry.video) continue;
    const tile = tiles.find(t => t.id === tileId);
    if (!tile || tile.ended) {
      // The stream ended: say so for a moment, then close.
      entry.video.srcObject = null;
      entry.msg.textContent = tr('Transmissão encerrada');
      entry.msg.classList.remove('hidden');
      popouts.delete(tileId);
      const { win } = entry;
      setTimeout(() => { try { win.close(); } catch { /* gone */ } }, 2500);
      continue;
    }
    if (!tile.mainStream) { closePopout(tileId); continue; } // stopped watching
    entry.msg.classList.add('hidden');
    const title = `${tile.kind === 'screen' ? `Tela de ${tile.name}` : tile.name} · kScreen`;
    if (entry.win.document.title !== title) entry.win.document.title = title;
    if (entry.video.srcObject !== tile.mainStream) entry.video.srcObject = tile.mainStream;
    if (entry.video.paused) entry.video.play().catch(() => {});
  }
  // Cards of popped-out streams: no video here, just a note and "Trazer de volta".
  const cards = [...document.querySelectorAll('.grid-participant-card, .strip-participant-card, #spotlight-main-card')];
  for (const card of cards) {
    const popped = popouts.has(card.dataset.id);
    card.classList.toggle('is-popped-out', popped);
    let note = card.querySelector(':scope > .popout-note');
    if (!popped) { note?.remove(); continue; }
    if (!note) {
      note = document.createElement('div');
      note.className = 'popout-note';
      note.innerHTML = `<span>${tr('Aberta em outra janela')}</span><button type="button">${tr('Trazer de volta')}</button>`;
      note.querySelector('button').addEventListener('click', (e) => {
        e.stopPropagation();
        closePopout(card.dataset.id);
      });
      card.append(note);
    }
  }
}

function openContextMenu(e, id, tileId = `${id}:user`) {
  const peer = findParticipant(id);
  if (!peer || !videoContextMenu) return;
  e.preventDefault();
  contextMenuTargetId = id;
  contextMenuTileId = tileId;

  const prefs = getAudioPrefs(id);
  const screen = tileId === `${id}:screen`;
  const remote = !peer.isLocal;
  // Discord: the person's card sets their voice volume, their stream sets the stream's volume.
  contextMenuVolumeKind = screen ? 'stream' : 'voice';
  ctxVolumeBox.classList.toggle('hidden', !remote);
  if (ctxVolumeTitle) ctxVolumeTitle.textContent = screen ? 'Volume da transmissão' : 'Volume do usuário';
  ctxVolumeSlider.setAttribute('aria-label', screen ? 'Volume da transmissão' : 'Volume do usuário');
  paintCtxVolume(prefs);
  $('ctx-row-video').classList.toggle('hidden', !remote || screen);
  ctxVideoOff.checked = !!prefs.videoOff;
  const canStop = remote && screen && engine.watching.has(id);
  const canPop = screen && canPopOut(tileId);
  videoContextMenu.setAttribute('aria-label', screen ? 'Opções da transmissão' : 'Opções do participante');
  // A stream's menu is its own: no "Abrir perfil" (that lives on the person's card).
  $('ctx-row-profile').classList.toggle('hidden', screen);
  $('ctx-sep-profile').classList.toggle('hidden', screen);
  $('ctx-row-popout').classList.toggle('hidden', !canPop);
  $('ctx-row-popout').textContent = tr(popouts.has(tileId) ? 'Trazer de volta' : 'Abrir em outra janela');
  $('ctx-row-watch').classList.toggle('hidden', !canStop);
  $('ctx-sep-watch').classList.toggle('hidden', !canStop && !canPop);
  // A stream's menu has nothing between the volume and the view options: one separator.
  $('ctx-sep-person').classList.toggle('hidden', !remote || screen);
  $('ctx-sep-view').classList.toggle('hidden', !remote);
  ctxShowNoVideo.checked = showNoVideo;

  fadeShow(videoContextMenu);
  const rect = videoContextMenu.getBoundingClientRect();
  const x = Math.max(8, Math.min(e.clientX ?? 100, window.innerWidth - rect.width - 8));
  const y = Math.max(8, Math.min(e.clientY ?? 100, window.innerHeight - rect.height - 8));
  videoContextMenu.style.left = `${x}px`;
  videoContextMenu.style.top = `${y}px`;
}

function closeContextMenu() {
  if (isShown(videoContextMenu)) {
    fadeHide(videoContextMenu);
    contextMenuTargetId = null;
  }
}

document.addEventListener('pointerdown', (e) => {
  if (videoContextMenu && !videoContextMenu.contains(e.target)) closeContextMenu();
});
window.addEventListener('blur', closeContextMenu);
window.addEventListener('resize', closeContextMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeContextMenu(); });

ctxVolumeSlider?.addEventListener('input', () => {
  if (!contextMenuTargetId) return;
  const f = VOLUME_FIELDS[contextMenuVolumeKind];
  saveAudioPrefs(contextMenuTargetId, { [f.volume]: parseInt(ctxVolumeSlider.value, 10), [f.muted]: false });
  paintCtxVolume(getAudioPrefs(contextMenuTargetId));
  refreshGains();
  scheduleRender();
});

// The speaker mutes / unmutes what the menu is about: their voice or their stream.
ctxBtnMute?.addEventListener('click', () => {
  if (!contextMenuTargetId) return;
  const f = VOLUME_FIELDS[contextMenuVolumeKind];
  saveAudioPrefs(contextMenuTargetId, { [f.muted]: !getAudioPrefs(contextMenuTargetId)[f.muted] });
  paintCtxVolume(getAudioPrefs(contextMenuTargetId));
  refreshGains();
  scheduleRender();
});

// "Desativar vídeo": hides their camera, just for you.
ctxVideoOff?.addEventListener('change', () => {
  if (!contextMenuTargetId) return;
  saveAudioPrefs(contextMenuTargetId, { videoOff: ctxVideoOff.checked });
  scheduleRender();
});

// "Abrir perfil": the person's profile card where the menu was.
$('ctx-row-profile')?.addEventListener('click', () => {
  const id = contextMenuTargetId;
  const rect = videoContextMenu.getBoundingClientRect();
  closeContextMenu();
  const info = id && peerProfile(id);
  if (info) openProfile(info, { x: rect.left, y: rect.top });
});

// "Abrir em outra janela": the stream in a window of its own (or back, if it already is).
$('ctx-row-popout')?.addEventListener('click', () => {
  const tileId = contextMenuTileId;
  closeContextMenu();
  if (!tileId) return;
  if (popouts.has(tileId)) closePopout(tileId);
  else popOutTile(tileId);
});

// "Parar de assistir" is an action: a plain menu item, no checkbox.
ctxWatchStop?.addEventListener('click', () => {
  const id = contextMenuTargetId;
  closeContextMenu();
  if (id) stopWatching(id);
});

ctxShowNoVideo?.addEventListener('change', () => {
  showNoVideo = ctxShowNoVideo.checked;
  try { localStorage.setItem('kscreen.showNoVideo', showNoVideo ? '1' : '0'); } catch { /* storage blocked */ }
  scheduleRender();
});

// ==========================================================================
// PROFILES (src/profile.js): names and photos open a small profile card
// ==========================================================================

function selfProfile() {
  return {
    name: myNickname,
    username: currentUser?.guest ? null : currentUser?.username,
    guest: !!currentUser?.guest,
    admin: !!currentUser?.admin,
    avatarUrl: safeAvatar(currentUser?.avatarUrl),
    nameColor: currentUser?.nameColor || null,
    self: true,
    call: engine.activeRoomId ? { device: engine.myDevice, micMuted: engine.isMicMuted, deafened: isAudioMuted, streaming: isLocalSharing } : null,
    onEdit: () => settings.open('account')
  };
}

// Someone in the room, by peer id ('local' = you).
function peerProfile(pid) {
  if (pid === 'local') return selfProfile();
  const info = engine.roster.get(pid);
  const peer = engine.peers.get(pid);
  if (!info && !peer) return null;
  const userId = String(info?.userId || '');
  return {
    name: peer?.name || info?.name || 'Amigo',
    username: info?.username || null,
    guest: info?.guest ?? userId.startsWith('g_'),
    avatarUrl: safeAvatar(peer?.avatarUrl || info?.avatarUrl),
    nameColor: info?.nameColor || null,
    self: false,
    call: { device: peer?.device || info?.device, micMuted: !!peer?.micMuted, deafened: !!peer?.deafened, streaming: !!peer?.isStreaming }
  };
}

// By account (chat): someone in the room, or what the message knows about its author.
function userProfile(userId, fallback = {}) {
  if (userId && userId === currentUser?.id) return selfProfile();
  for (const [pid, info] of engine.roster) if (info.userId === userId && engine.peers.has(pid)) return peerProfile(pid);
  return {
    name: fallback.name || 'Usuário',
    username: fallback.guest ? null : fallback.username || null,
    guest: fallback.guest ?? String(userId || '').startsWith('g_'),
    avatarUrl: safeAvatar(fallback.avatarUrl),
    nameColor: fallback.nameColor || null,
    self: false,
    call: null
  };
}

// Names on the cards (grid, strip, focused card). Capture phase: the card's own click
// (focus / watch) must not run.
kennyyStage?.addEventListener('click', (e) => {
  const name = e.target.closest?.('.nametag-text, #spotlight-nametag-text');
  if (!name) return;
  const pid = name.closest('[data-pid]')?.dataset.pid;
  const info = pid && peerProfile(pid);
  if (!info) return;
  e.stopPropagation();
  e.preventDefault();
  openProfile(info, name);
}, true);
// The focused person's photo in the top bar, and the photos of who is watching.
headerAvatar?.addEventListener('click', () => {
  const id = activeSpotlightId || '';
  const pid = id.slice(0, id.lastIndexOf(':'));
  const info = pid && peerProfile(pid);
  if (info) openProfile(info, headerAvatar);
});
headerViewers?.addEventListener('click', (e) => {
  const img = e.target.closest('.viewer-avatar');
  const info = img?.dataset.pid && peerProfile(img.dataset.pid);
  if (info) openProfile(info, img);
});
// Home screen: your own photo and name.
for (const el of [homeUserAvatar, homeUserName]) el?.addEventListener('click', () => { if (currentUser) openProfile(selfProfile(), el); });

// ==========================================================================
// WAKE LOCK
// ==========================================================================

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* not supported or denied */ }
}

function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && engine.activeRoomId) requestWakeLock();
});

// ==========================================================================
// LOCAL STREAM HANDLERS
// ==========================================================================

function handleLocalStream(stream) {
  localStream = stream;
  isLocalSharing = true;
  btnDockScreenshare?.classList.add('active');
  btnDockScreenshare?.setAttribute('aria-pressed', 'true');
  if (btnDockScreenshare) btnDockScreenshare.title = 'Parar de transmitir';
  btnShareMenu?.classList.remove('hidden');
  const { resolution, fps } = engine.shareSettings;
  const wasLive = isLocalSharing && localStreamShown === stream;
  localStreamShown = stream;
  if (!wasLive) playSound('streamStart');
  if (wasLive) {
    // Same share, its audio just arrived (desktop app): nothing new to announce.
  } else if (stream.getAudioTracks().length) {
    showToast(`Ao vivo em ${SHARE_RESOLUTIONS[resolution].label} a ${fps} FPS, com áudio.`);
  } else if (window.kscreenDesktop) {
    showToast('Ao vivo sem som. O som do PC fica na engrenagem do seletor.', 6000);
  } else {
    // Browsers only capture audio for tabs / whole screen, and only when the box is ticked.
    const firefox = /firefox/i.test(navigator.userAgent);
    showToast(firefox
      ? 'Compartilhando SEM áudio: o Firefox não captura o som da tela. Use o Chrome ou Edge para transmitir com som.'
      : 'Compartilhando SEM áudio. Para ter som, escolha uma aba ou a tela inteira e marque "Compartilhar áudio" (janelas não têm som).', 9000);
  }
  renderShareMenu();
  // The capture reports its real size only after the first frames.
  setTimeout(renderShareMenu, 1500);
  renderStage();
}

function handleLocalShareEnded() {
  isLocalSharing = false;
  localStream = null;
  btnDockScreenshare?.classList.remove('active');
  btnDockScreenshare?.setAttribute('aria-pressed', 'false');
  if (btnDockScreenshare) btnDockScreenshare.title = 'Compartilhar tela';
  btnShareMenu?.classList.add('hidden');
  localStreamShown = null;
  toggleShareMenu(false);
  renderShareMenu();
  if (engine.activeRoomId) {
    playSound('streamStop');
    showToast('Compartilhamento de tela encerrado.');
  }
  renderStage();
}

// ==========================================================================
// DOCK CONTROLS
// ==========================================================================

function setMicButton(muted) {
  btnDockMic?.querySelector('.mic-on')?.classList.toggle('hidden', muted);
  btnDockMic?.querySelector('.mic-off')?.classList.toggle('hidden', !muted);
  btnDockMic?.classList.toggle('muted', muted);
  btnDockMic?.setAttribute('aria-pressed', String(!muted));
  if (btnDockMic) btnDockMic.title = muted ? 'Ativar microfone' : 'Silenciar microfone';
}

function setCameraButton(on) {
  btnDockCamera?.querySelector('.cam-on')?.classList.toggle('hidden', !on);
  btnDockCamera?.querySelector('.cam-off')?.classList.toggle('hidden', on);
  btnDockCamera?.classList.toggle('muted', !on);
  // Lit like the screen share button while live, so a camera on is noticed.
  btnDockCamera?.classList.toggle('active', on);
  btnDockCamera?.setAttribute('aria-pressed', String(on));
  if (btnDockCamera) btnDockCamera.title = on ? 'Desligar câmera' : 'Ligar câmera';
}

btnDockCamera?.addEventListener('click', async () => {
  btnDockCamera.disabled = true;
  try {
    const on = await engine.toggleCamera();
    setCameraButton(on);
    playSound(on ? 'cameraOn' : 'cameraOff');
    scheduleRender();
  } catch (err) {
    const messages = {
      NotAllowedError: 'Permissão da câmera negada.',
      NotFoundError: 'Nenhuma câmera encontrada.',
      NotReadableError: 'A câmera está em uso por outro programa.'
    };
    showToast(messages[err.name] || 'Não foi possível ligar a câmera.');
  } finally {
    btnDockCamera.disabled = false;
  }
});

btnDockMic?.addEventListener('click', async () => {
  btnDockMic.disabled = true;
  try {
    const muted = await engine.toggleMute();
    setMicButton(muted);
    micMutedByDeafen = false;
    saveVoiceState({ mic: !muted });
    // Discord: turning the mic back on while deafened also brings the room audio back.
    if (!muted && isAudioMuted) {
      await setDeafened(false, { restoreMic: false });
      showToast('Microfone e áudio da sala ativados');
      return;
    }
    playSound(muted ? 'mute' : 'unmute');
    showToast(muted ? 'Microfone silenciado' : 'Microfone ativado');
  } catch (err) {
    showToast(err.name === 'NotAllowedError' ? 'Permissão do microfone negada.' : 'Não foi possível usar o microfone.');
  } finally {
    btnDockMic.disabled = false;
  }
});

// Discord: deafening also mutes the mic; undeafening turns it back on only if it was on before.
let micMutedByDeafen = false;

// Mute / deafen are remembered (localStorage) across rooms and reloads.
// `mic` is what you chose for the mic; deafening mutes it without changing that choice.
const VOICE_STATE_KEY = 'kscreen.voiceState';
function loadVoiceState() {
  try {
    const v = JSON.parse(localStorage.getItem(VOICE_STATE_KEY) || '{}');
    return { mic: v.mic === true, deaf: v.deaf === true };
  } catch { return { mic: false, deaf: false }; }
}
function saveVoiceState(change) {
  try { localStorage.setItem(VOICE_STATE_KEY, JSON.stringify({ ...loadVoiceState(), ...change })); } catch { /* storage blocked */ }
}
// Right after entering a room: the mic always starts closed there, so reapply the saved state.
async function restoreVoiceState() {
  const { mic, deaf } = loadVoiceState();
  if (deaf) {
    if (!isAudioMuted) await setDeafened(true, { silent: true });
    micMutedByDeafen = mic;
    return;
  }
  if (isAudioMuted) await setDeafened(false, { restoreMic: false, silent: true });
  if (mic && engine.isMicMuted) {
    try { setMicButton(await engine.toggleMute()); } catch {
      showToast('Não foi possível ligar o microfone.');
    }
  }
}

async function setDeafened(on, { restoreMic = true, silent = false } = {}) {
  isAudioMuted = on;
  if (!silent) saveVoiceState({ deaf: on });
  engine.setDeafened(on);
  btnDockAudio?.querySelector('.audio-on')?.classList.toggle('hidden', on);
  btnDockAudio?.querySelector('.audio-off')?.classList.toggle('hidden', !on);
  btnDockAudio?.classList.toggle('muted', on);
  btnDockAudio?.setAttribute('aria-pressed', String(on));
  if (btnDockAudio) btnDockAudio.title = on ? 'Ativar áudio da sala' : 'Silenciar áudio da sala';
  refreshGains();
  if (!silent) playSound(on ? 'deafen' : 'undeafen');
  try {
    if (on && engine.micStream && !engine.isMicMuted) {
      setMicButton(await engine.toggleMute());
      micMutedByDeafen = true;
    } else if (!on && restoreMic && micMutedByDeafen && engine.isMicMuted) {
      setMicButton(await engine.toggleMute());
    }
  } catch {}
  if (!on) micMutedByDeafen = false;
}

btnDockAudio?.addEventListener('click', async () => {
  await setDeafened(!isAudioMuted);
  showToast(isAudioMuted ? 'Áudio da sala silenciado' : 'Áudio da sala ativado');
});


// --------------------------------------------------------------------------
// Voice / video device menus (chevrons next to mic and camera)
// --------------------------------------------------------------------------

const DEVICE_PREFS_KEY = 'kscreen.devices';
const DEVICE_DEFAULTS = {
  mic: 'default', out: 'default', cam: 'default', micVolume: 100, outVolume: 100,
  noiseSuppression: true, noiseStrength: 80, echoCancellation: true
};
const devicePrefs = (() => {
  try { return { ...DEVICE_DEFAULTS, ...JSON.parse(localStorage.getItem(DEVICE_PREFS_KEY) || '{}') }; } catch { return { ...DEVICE_DEFAULTS }; }
})();
function saveDevicePrefs() {
  try { localStorage.setItem(DEVICE_PREFS_KEY, JSON.stringify(devicePrefs)); } catch { /* storage blocked */ }
}
engine.micDeviceId = devicePrefs.mic;
engine.micVolume = devicePrefs.micVolume;
engine.cameraDeviceId = devicePrefs.cam;
engine.noiseSuppression = devicePrefs.noiseSuppression;
engine.noiseStrength = devicePrefs.noiseStrength;
engine.echoCancellation = devicePrefs.echoCancellation;

const canPickOutput = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
function applyOutputDevice() {
  if (!canPickOutput || !audioContext) return;
  audioContext.setSinkId(devicePrefs.out === 'default' ? '' : devicePrefs.out).catch(() => {
    showToast('Não foi possível usar esse dispositivo de saída.');
  });
}

const deviceMenu = $('device-menu');
const deviceMain = $('device-main');
const deviceSub = $('device-sub');
const btnMicMenu = $('btn-mic-menu');
const btnCamMenu = $('btn-cam-menu');
const btnAudioMenu = $('btn-audio-menu');
const DEVICE_MENU_BUTTONS = { voice: btnMicMenu, output: btnAudioMenu, video: btnCamMenu };
let deviceMenuKind = null; // 'voice' (mic, input) | 'output' (headphones) | 'video'
let deviceSubKind = null; // 'audioinput' | 'audiooutput' | 'videoinput'

const GENERIC_DEVICE = { audioinput: 'Microfone', audiooutput: 'Alto-falantes', videoinput: 'Câmera' };
const DEVICE_PREF = { audioinput: 'mic', audiooutput: 'out', videoinput: 'cam' };
const CHEVRON_RIGHT = '<svg class="device-row-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>';
const SPEAKER_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>';

// "Microfone (Realtek(R) Audio) (0bda:0001)" -> { title: 'Microfone', detail: 'Realtek(R) Audio' }
function splitDeviceLabel(label) {
  const text = (label || '')
    .replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '')
    .replace(/^(padrão|default|comunicações|communications)\s*-\s*/i, '')
    .trim();
  const open = text.indexOf(' (');
  if (open > 0 && text.endsWith(')')) return { title: text.slice(0, open), detail: text.slice(open + 2, -1) };
  return { title: text, detail: '' };
}

// Browsers hide device names (and most devices) until the site may use the mic/camera.
// Asking once (and releasing right away) makes the full list appear.
async function ensureDeviceAccess(kind) {
  let all = [];
  try { all = await navigator.mediaDevices.enumerateDevices(); } catch { return; }
  const want = kind === 'videoinput' ? 'videoinput' : 'audioinput';
  if (all.some(d => d.kind === want && d.label)) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia(want === 'videoinput' ? { video: true } : { audio: true });
    for (const track of stream.getTracks()) track.stop();
  } catch { /* denied: the list stays generic */ }
}

async function listDevices(kind) {
  let all = [];
  try { all = await navigator.mediaDevices.enumerateDevices(); } catch { /* unsupported */ }
  const list = all.filter(d => d.kind === kind && d.deviceId && d.deviceId !== 'communications');
  const items = [];
  if (kind !== 'videoinput') {
    const parts = splitDeviceLabel(list.find(d => d.deviceId === 'default')?.label);
    items.push({ id: 'default', title: parts.detail || parts.title || GENERIC_DEVICE[kind], detail: 'Padrão do sistema' });
  }
  list.filter(d => d.deviceId !== 'default').forEach((d, i) => {
    const parts = splitDeviceLabel(d.label);
    items.push({ id: d.deviceId, title: parts.title || `${GENERIC_DEVICE[kind]} ${i + 1}`, detail: parts.detail });
  });
  return items;
}

function selectedDeviceId(kind, items) {
  if (kind === 'videoinput') {
    const live = engine.cameraStream?.getVideoTracks()[0]?.getSettings().deviceId;
    if (live && items.some(d => d.id === live)) return live;
    return items.some(d => d.id === devicePrefs.cam) ? devicePrefs.cam : items[0]?.id;
  }
  const id = devicePrefs[DEVICE_PREF[kind]];
  return items.some(d => d.id === id) ? id : 'default';
}

// No device of this kind at all (not even one hidden behind the permission): nothing to pick.
async function noDevices(kind) {
  try {
    return !(await navigator.mediaDevices.enumerateDevices()).some(d => d.kind === kind);
  } catch { return false; }
}

function deviceRow(kind, label, items, { none = false } = {}) {
  const current = items.find(d => d.id === selectedDeviceId(kind, items));
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'device-row';
  row.dataset.sub = kind;
  row.setAttribute('role', 'menuitem');
  row.setAttribute('aria-haspopup', 'menu');
  row.setAttribute('aria-expanded', String(deviceSubKind === kind));
  row.classList.toggle('open', deviceSubKind === kind);
  row.innerHTML = `<span class="device-row-text"><span class="device-row-label"></span><span class="device-row-value"></span></span>${CHEVRON_RIGHT}`;
  row.querySelector('.device-row-label').textContent = label;
  row.querySelector('.device-row-value').textContent = current && !none ? (current.id === 'default' ? current.title : current.detail || current.title) : 'Nenhum encontrado';
  // Greyed out and closed when there is nothing to list (an empty submenu helps nobody).
  row.disabled = none;
  if (none) row.removeAttribute('aria-haspopup');
  row.addEventListener('click', () => openDeviceSub(deviceSubKind === kind ? null : kind));
  return row;
}

// A labelled slider with a typable percentage. Volumes go 0-200%; `max` and `icon` change that.
function volumeBlock(label, value, onChange, { max = 200, icon = SPEAKER_ICON } = {}) {
  const box = document.createElement('div');
  box.className = 'device-volume';
  box.innerHTML = `<div class="device-volume-head"><span></span><input class="device-volume-pill" type="text" inputmode="numeric" maxlength="4" spellcheck="false"></div>
    <div class="device-volume-row">${icon}<input type="range" min="0" max="${max}" step="1" class="device-slider"></div>`;
  box.querySelector('.device-volume-head span').textContent = label;
  const pill = box.querySelector('.device-volume-pill');
  const slider = box.querySelector('input[type="range"]');
  slider.setAttribute('aria-label', label);
  pill.setAttribute('aria-label', `${label} em porcentagem`);
  const paint = (v) => {
    if (document.activeElement !== pill) pill.value = `${v}%`;
    slider.style.setProperty('--fill', `${v * 100 / max}%`);
  };
  // The percentage can be typed (0 to max).
  const commit = () => {
    const v = Math.max(0, Math.min(max, parseInt(pill.value.replace(/\D/g, ''), 10) || 0));
    slider.value = v;
    pill.value = `${v}%`;
    paint(v);
    onChange(v);
  };
  pill.addEventListener('focus', () => { pill.value = pill.value.replace('%', ''); pill.select(); });
  pill.addEventListener('blur', commit);
  pill.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') pill.blur();
    if (e.key === 'Escape') { e.stopPropagation(); pill.value = `${slider.value}`; pill.blur(); }
  });
  slider.value = value;
  paint(value);
  slider.addEventListener('input', () => {
    const v = Number(slider.value);
    paint(v);
    onChange(v);
  });
  return box;
}

// On/off setting that applies right away and is remembered: a switch (actions are plain items,
// marking people/items in a right-click menu or list uses checkboxes).
function switchRow(label, checked, onChange, hint = '') {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'switch-row';
  row.setAttribute('role', 'menuitemcheckbox');
  row.setAttribute('aria-checked', String(!!checked));
  row.innerHTML = '<span class="switch-row-text"><span class="switch-row-label"></span><span class="switch-row-hint"></span></span><span class="k-switch" aria-hidden="true"></span>';
  row.querySelector('.switch-row-label').textContent = label;
  row.querySelector('.switch-row-hint').textContent = hint;
  row.addEventListener('click', () => {
    const next = row.getAttribute('aria-checked') !== 'true';
    row.setAttribute('aria-checked', String(next));
    onChange(next);
  });
  return row;
}

const GEAR_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>';

// Last item of the dock menus: the full settings window, on the matching page.
function settingsLinkRow(label, section) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'device-row device-settings-link';
  row.setAttribute('role', 'menuitem');
  row.innerHTML = `<span class="device-row-text"><span class="device-row-label"></span></span>${GEAR_ICON}`;
  row.querySelector('.device-row-label').textContent = label;
  row.addEventListener('click', () => settings.open(section));
  return row;
}

const NOISE_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 11v2"/></svg>';

function deviceSeparator() {
  const sep = document.createElement('div');
  sep.className = 'device-separator';
  return sep;
}

async function renderDeviceMenu() {
  const kind = deviceMenuKind;
  if (!kind) return;
  const parts = [];
  if (kind === 'output') {
    // Headphones: where the call plays and how loud.
    if (canPickOutput) parts.push(deviceRow('audiooutput', 'Dispositivo de saída', await listDevices('audiooutput'), { none: await noDevices('audiooutput') }), deviceSeparator());
    parts.push(volumeBlock('Volume de saída', devicePrefs.outVolume, (v) => {
      devicePrefs.outVolume = v;
      refreshGains();
      paintStageVolume();
      saveDevicePrefs();
    }));
    parts.push(deviceSeparator(), settingsLinkRow('Configurações de voz', 'voice'));
  } else if (kind === 'voice') {
    // Microphone: input only (the output lives on the headphones).
    parts.push(deviceRow('audioinput', 'Dispositivo de entrada', await listDevices('audioinput'), { none: await noDevices('audioinput') }));
    parts.push(deviceSeparator());
    parts.push(volumeBlock('Volume de entrada', devicePrefs.micVolume, (v) => {
      devicePrefs.micVolume = v;
      engine.setMicVolume(v);
      saveDevicePrefs();
    }));
    parts.push(deviceSeparator());
    const setProcessing = (patch) => {
      Object.assign(devicePrefs, patch);
      saveDevicePrefs();
      engine.setMicProcessing(patch).catch(() => showToast('Não foi possível aplicar no microfone.'));
    };
    parts.push(switchRow('Supressão de ruído', devicePrefs.noiseSuppression, (on) => {
      setProcessing({ noiseSuppression: on });
      renderDeviceMenu(); // the strength slider shows up / goes away
    }));
    if (devicePrefs.noiseSuppression) {
      parts.push(volumeBlock('Intensidade', devicePrefs.noiseStrength, (v) => setProcessing({ noiseStrength: v }), { max: 100, icon: NOISE_ICON }));
    }
    parts.push(switchRow('Cancelamento de eco', devicePrefs.echoCancellation, (on) => setProcessing({ echoCancellation: on })));
    parts.push(deviceSeparator(), settingsLinkRow('Configurações de voz', 'voice'));
  } else {
    const none = await noDevices('videoinput');
    parts.push(deviceRow('videoinput', 'Câmera', await listDevices('videoinput'), { none }));
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'device-row device-action';
    toggle.setAttribute('role', 'menuitem');
    toggle.textContent = engine.cameraStream ? 'Desligar câmera' : 'Ligar câmera';
    toggle.disabled = none && !engine.cameraStream; // no camera to turn on
    toggle.addEventListener('click', () => {
      closeDeviceMenu();
      btnDockCamera?.click();
    });
    parts.push(deviceSeparator(), toggle, settingsLinkRow('Configurações de vídeo', 'voice'));
  }
  if (kind !== deviceMenuKind) return;
  deviceMain.replaceChildren(...parts);
  if (deviceSubKind) await renderDeviceSub();
  joinDeviceMenus();
}

async function renderDeviceMenuRows() {
  for (const row of deviceMain.querySelectorAll('.device-row[data-sub]')) {
    const kind = row.dataset.sub;
    const items = await listDevices(kind);
    const current = items.find(d => d.id === selectedDeviceId(kind, items));
    row.querySelector('.device-row-value').textContent = current ? (current.id === 'default' ? current.title : current.detail || current.title) : 'Nenhum encontrado';
  }
}

async function renderDeviceSub() {
  const kind = deviceSubKind;
  const items = await listDevices(kind);
  if (kind !== deviceSubKind) return;
  const selected = selectedDeviceId(kind, items);
  const list = document.createElement('div');
  list.className = 'device-sub-list';
  list.replaceChildren(...items.map((d) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'device-option';
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', String(d.id === selected));
    item.classList.toggle('selected', d.id === selected);
    item.innerHTML = '<span class="device-option-title"></span><span class="device-option-detail"></span>';
    item.querySelector('.device-option-title').textContent = d.title;
    item.querySelector('.device-option-detail').textContent = d.detail;
    item.addEventListener('click', () => pickDevice(kind, d.id));
    return item;
  }));
  const keepScroll = deviceSub.querySelector('.device-sub-list')?.scrollTop;
  deviceSub.replaceChildren(list);
  fitSubList(deviceMain, deviceSub, keepScroll);
}

// Cap the list to the room between the top of the window and the bottom of the menu (the
// submenu never goes below the menu), so a long list scrolls instead of leaving the screen.
const MENU_EDGE = 8;
function fitSubList(main, sub, scrollTop) {
  const list = sub.querySelector('.device-sub-list');
  if (!list) return;
  const narrow = matchMedia('(max-width: 600px)').matches;
  const pad = 16; // the submenu's padding, top + bottom
  const room = narrow
    ? main.offsetHeight - pad // phones: the submenu covers the menu
    : main.getBoundingClientRect().bottom - MENU_EDGE - pad;
  list.style.maxHeight = `${Math.max(120, Math.floor(room))}px`;
  if (scrollTop != null) list.scrollTop = scrollTop;
}

// On opening, bring the selected device into view (only the list scrolls, never the page).
function scrollToSelectedDevice() {
  const list = deviceSub.querySelector('.device-sub-list');
  const sel = list?.querySelector('.device-option.selected');
  if (sel && sel.offsetTop + sel.offsetHeight > list.clientHeight) {
    list.scrollTop = sel.offsetTop - (list.clientHeight - sel.offsetHeight) / 2;
  }
}

async function pickDevice(kind, id) {
  devicePrefs[DEVICE_PREF[kind]] = id;
  saveDevicePrefs();
  try {
    if (kind === 'audioinput') await engine.setMicDevice(id);
    else if (kind === 'audiooutput') applyOutputDevice();
    else {
      await engine.setCameraDevice(id);
      scheduleRender();
    }
  } catch {
    showToast(kind === 'videoinput' ? 'Não foi possível usar essa câmera.' : 'Não foi possível usar esse microfone.');
  }
  renderDeviceMenu();
}

async function openDeviceSub(kind) {
  if (deviceSubKind === kind) return;
  deviceSubKind = kind;
  for (const row of deviceMain.querySelectorAll('.device-row[data-sub]')) {
    row.classList.toggle('open', row.dataset.sub === kind);
    row.setAttribute('aria-expanded', String(row.dataset.sub === kind));
  }
  if (kind) {
    await ensureDeviceAccess(kind);
    if (kind !== deviceSubKind) return;
    await renderDeviceSub();
    if (kind !== deviceSubKind) return;
    renderDeviceMenuRows();
  }
  if (kind !== deviceSubKind) return;
  deviceSub.classList.toggle('hidden', !kind);
  if (kind) scrollToSelectedDevice();
  joinDeviceMenus();
}

// Menu and submenu are drawn as one shape: an SVG path around the union of the two boxes.
// Convex corners are rounded and concave ones get the same curve the other way, each radius
// clamped to half of its edges, so no combination of heights can leave a seam or notch.
const MENU_RADIUS = 12;
const SNAP = 16; // steps smaller than this would look like a glitch: line the edges up instead
function addMenuShape(menu) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('device-shape');
  svg.setAttribute('aria-hidden', 'true');
  svg.append(document.createElementNS('http://www.w3.org/2000/svg', 'path'));
  menu?.prepend(svg);
  return svg;
}
const deviceShape = addMenuShape(deviceMenu);

function roundedPolygonPath(points, radius) {
  // Drop repeated and collinear points.
  const pts = [];
  for (const p of points) {
    const last = pts[pts.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p);
  }
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  const clean = pts.filter((p, i) => {
    const a = pts[(i - 1 + pts.length) % pts.length];
    const b = pts[(i + 1) % pts.length];
    return (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]) !== 0;
  });
  const n = clean.length;
  const len = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  let d = '';
  clean.forEach((p, i) => {
    const prev = clean[(i - 1 + n) % n];
    const next = clean[(i + 1) % n];
    const inLen = len(prev, p);
    const outLen = len(p, next);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    const start = [p[0] + (prev[0] - p[0]) / inLen * r, p[1] + (prev[1] - p[1]) / inLen * r];
    const end = [p[0] + (next[0] - p[0]) / outLen * r, p[1] + (next[1] - p[1]) / outLen * r];
    const cross = (p[0] - prev[0]) * (next[1] - p[1]) - (p[1] - prev[1]) * (next[0] - p[0]);
    d += `${i ? 'L' : 'M'}${start[0]},${start[1]} A${r},${r} 0 0 ${cross > 0 ? 1 : 0} ${end[0]},${end[1]} `;
  });
  return `${d}Z`;
}

function joinDeviceMenus() {
  // The menu opens upward from the dock: on short windows it scrolls instead of leaving the screen.
  const room = kennyyDockWrapper.getBoundingClientRect().top - 10 - MENU_EDGE;
  const maxH = `${Math.max(160, Math.floor(room))}px`;
  if (deviceMain.style.maxHeight !== maxH) deviceMain.style.maxHeight = maxH;
  joinMenus(deviceMenu, deviceMain, deviceSub, deviceShape, deviceMain.querySelector('.device-row.open'));
  placeDeviceMenu();
}

// Shared by the voice/video menus and the live (share) menu.
function joinMenus(menu, main, sub, shape, row) {
  const shapePath = shape.firstChild;
  main.style.minHeight = '';
  sub.style.minHeight = '';
  sub.style.top = '0px';
  const open = !sub.classList.contains('hidden');
  const narrow = matchMedia('(max-width: 600px)').matches;
  menu.classList.toggle('joined', open && !narrow);
  if (open && !narrow) {
    let mainH = main.offsetHeight;
    let subH = sub.offsetHeight;
    const mainW = main.offsetWidth;
    const subW = sub.offsetWidth;
    // The submenu lines up with its row; when it doesn't fit below, it grows upward so
    // the menu itself never moves.
    let top = row ? row.offsetTop - 8 : 0;
    if (top + subH > mainH) top = mainH - subH;
    if (Math.abs(top) < SNAP) top = 0;
    const gap = mainH - (top + subH);
    if (gap > 0 && gap < SNAP) { subH += gap; sub.style.minHeight = `${subH}px`; }
    if (gap < 0 && gap > -SNAP) { mainH -= gap; main.style.minHeight = `${mainH}px`; }
    sub.style.top = `${top}px`;

    const minY = Math.min(0, top);
    const maxY = Math.max(mainH, top + subH);
    const y = (v) => v - minY;
    const x2 = mainW + subW;
    // Clockwise around the union of [0,0,mainW,mainH] and [mainW,top,x2,top+subH].
    const path = roundedPolygonPath([
      [0, y(0)], [mainW, y(0)], [mainW, y(top)], [x2, y(top)],
      [x2, y(top + subH)], [mainW, y(top + subH)], [mainW, y(mainH)], [0, y(mainH)]
    ], MENU_RADIUS);
    shape.style.top = `${minY}px`;
    shape.setAttribute('width', x2);
    shape.setAttribute('height', maxY - minY);
    shape.setAttribute('viewBox', `0 0 ${x2} ${maxY - minY}`);
    shapePath.setAttribute('d', path);
  }
}

function placeDeviceMenu() {
  const anchor = (deviceMenuKind === 'video' ? btnDockCamera : btnDockMic)?.closest('.dock-group');
  if (!anchor) return;
  const dock = kennyyDockWrapper.getBoundingClientRect();
  const width = deviceMain.offsetWidth + (deviceSub.classList.contains('hidden') ? 0 : deviceSub.offsetWidth);
  const left = Math.max(8, Math.min(anchor.getBoundingClientRect().left, window.innerWidth - 8 - width));
  deviceMenu.style.left = `${left - dock.left}px`;
}

function openDeviceMenu(kind) {
  toggleShareMenu(false);
  deviceMenuKind = kind;
  deviceSubKind = null;
  deviceSub.classList.add('hidden');
  deviceMenu.classList.remove('joined');
  deviceMain.replaceChildren();
  fadeShow(deviceMenu);
  deviceMenu.setAttribute('aria-label', { voice: 'Opções de voz', output: 'Opções de saída', video: 'Opções de vídeo' }[kind]);
  for (const [k, btn] of Object.entries(DEVICE_MENU_BUTTONS)) {
    btn?.setAttribute('aria-expanded', String(kind === k));
    btn?.classList.toggle('active', kind === k);
  }
  renderDeviceMenu();
}

function closeDeviceMenu() {
  if (!deviceMenuKind) return;
  deviceMenuKind = null;
  deviceSubKind = null;
  fadeHide(deviceMenu); // the submenu fades with it and is reset on the next open
  for (const btn of Object.values(DEVICE_MENU_BUTTONS)) {
    btn?.setAttribute('aria-expanded', 'false');
    btn?.classList.remove('active');
  }
}

btnMicMenu?.addEventListener('click', () => (deviceMenuKind === 'voice' ? closeDeviceMenu() : openDeviceMenu('voice')));
btnCamMenu?.addEventListener('click', () => (deviceMenuKind === 'video' ? closeDeviceMenu() : openDeviceMenu('video')));
btnAudioMenu?.addEventListener('click', () => (deviceMenuKind === 'output' ? closeDeviceMenu() : openDeviceMenu('output')));
document.addEventListener('pointerdown', (e) => {
  if (deviceMenuKind && !deviceMenu.contains(e.target) && !Object.values(DEVICE_MENU_BUTTONS).some(b => b?.contains(e.target))) closeDeviceMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !deviceMenuKind) return;
  if (deviceSubKind) openDeviceSub(null);
  else closeDeviceMenu();
});
window.addEventListener('resize', closeDeviceMenu);
navigator.mediaDevices?.addEventListener?.('devicechange', () => renderDeviceMenu());

// Phones that can't capture the screen (iPhone/iPad, old Android): say why and offer the camera.
async function explainShareUnsupported(message) {
  const canCamera = !!navigator.mediaDevices?.getUserMedia && !engine.cameraStream && btnDockCamera && !btnDockCamera.disabled;
  if (!canCamera) return showToast(message, 8000);
  const ok = await confirmDialog({ title: 'Não dá para compartilhar a tela aqui', message, confirmLabel: 'Ligar câmera' });
  if (ok) btnDockCamera.click();
}

async function startShare() {
  try {
    await engine.startScreenShare();
    activeSpotlightId = 'local:screen';
  } catch (err) {
    if (err.code === 'share-unsupported') return explainShareUnsupported(err.message);
    if (err.name === 'NotAllowedError' || err.name === 'AbortError') return; // user cancelled the picker
    console.error('Falha ao compartilhar tela:', err);
    showToast(err.message?.includes('navegador') || err.message?.includes('HTTPS')
      ? err.message
      : 'Não foi possível iniciar a captura de tela.', 5000);
  }
}

// The screen button starts or stops the share; the arrow next to it (only while live) has the rest.
btnDockScreenshare?.addEventListener('click', () => {
  if (isLocalSharing) engine.stopScreenShare();
  else startShare();
});

btnShareMenu?.addEventListener('click', (e) => {
  // detail 0 = keyboard (Enter/Space): then move focus into the menu.
  toggleShareMenu(undefined, { focus: e.detail === 0 });
});

// --------------------------------------------------------------------------
// Live menu: stop, change source, quality, audio
// --------------------------------------------------------------------------

function buildRadio(container, name, value, label, onPick) {
  const row = document.createElement('label');
  row.className = 'share-menu-item share-radio';
  const text = document.createElement('span');
  text.textContent = label;
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = name;
  input.value = value;
  input.addEventListener('change', () => onPick(value));
  const ring = document.createElement('span');
  ring.className = 'radio-ring';
  ring.setAttribute('aria-hidden', 'true');
  row.append(text, input, ring);
  container.append(row);
}

function renderShareMenu() {
  if (!shareMenu) return;
  const { resolution, fps, audioQuality } = engine.shareSettings;
  const current = { 'share-fps': String(fps), 'share-resolution': resolution, 'share-audio-quality': audioQuality };
  for (const input of shareMenu.querySelectorAll('input[type="radio"]')) {
    input.checked = input.value === current[input.name];
  }
  const hasAudio = engine.hasShareAudio();
  shareMenuAudio.checked = hasAudio && engine.shareAudioEnabled;
  shareMenuAudio.disabled = !hasAudio;
  shareMenuAudioRow.classList.toggle('disabled', !hasAudio);
  shareMenuAudioRow.title = hasAudio ? '' : 'Esta transmissão não tem áudio';
  const track = localStream?.getVideoTracks()[0];
  const actual = track?.getSettings() || {};
  shareMenuStatus.textContent = engine.capturePaused
    ? 'Pausado: o jogo não está em primeiro plano'
    : track && actual.height
      ? `${actual.width}×${actual.height} · ${fps} FPS`
      : `${SHARE_RESOLUTIONS[resolution].label} · ${fps} FPS`;
}

function placeShareMenu() {
  // Line the menu up with the share button; keep it on screen.
  const dock = kennyyDockWrapper.getBoundingClientRect();
  const btn = btnDockScreenshare.getBoundingClientRect();
  const width = shareMain.offsetWidth + (shareSubmenu.classList.contains('hidden') ? 0 : shareSubmenu.offsetWidth);
  const left = Math.max(8 - dock.left, Math.min(btn.left - dock.left, window.innerWidth - 8 - width - dock.left));
  shareMenu.style.setProperty('--share-menu-left', `${left}px`);
}

const shareShape = addMenuShape(shareMenu);
function toggleQuality(open = shareSubmenu.classList.contains('hidden')) {
  shareSubmenu.classList.toggle('hidden', !open);
  shareMenuQuality.setAttribute('aria-expanded', String(open));
  if (open) fitSubList(shareMain, shareSubmenu);
  joinMenus(shareMenu, shareMain, shareSubmenu, shareShape, open ? shareMenuQuality : null);
  // Like the device menu: the whole menu shifts left when the submenu wouldn't fit.
  placeShareMenu();
}

function toggleShareMenu(open = !isShown(shareMenu), { focus = false } = {}) {
  if (!shareMenu) return;
  if (open && !isLocalSharing) return;
  if (open) closeDeviceMenu();
  if (open) fadeShow(shareMenu);
  else fadeHide(shareMenu);
  btnShareMenu?.setAttribute('aria-expanded', String(open));
  btnShareMenu?.classList.toggle('active', open);
  if (open) {
    renderShareMenu();
    toggleQuality(false);
    if (focus) shareMenu.querySelector('.share-menu-item')?.focus({ preventScroll: true });
  }
}

async function pickShareSetting(change) {
  try {
    const settings = await engine.setShareSettings(change);
    saveShareSettings(settings);
    if ('audioQuality' in change) showToast(`Áudio da transmissão em ${SHARE_AUDIO_QUALITIES[settings.audioQuality].detail}, estéreo.`);
    else if (isLocalSharing) showToast(`Transmitindo em ${SHARE_RESOLUTIONS[settings.resolution].label} a ${settings.fps} FPS.`);
    // The capture takes a moment to settle on its new size.
    setTimeout(renderShareMenu, 1500);
  } catch {
    showToast('Não foi possível aplicar essa qualidade.');
  }
  renderShareMenu();
}

if (shareMenu) {
  for (const fps of SHARE_FPS) {
    buildRadio(shareFpsOptions, 'share-fps', String(fps), `${fps} FPS`, (value) => pickShareSetting({ fps: Number(value) }));
  }
  for (const [key, preset] of Object.entries(SHARE_RESOLUTIONS)) {
    buildRadio(shareResolutionOptions, 'share-resolution', key, preset.label, (resolution) => pickShareSetting({ resolution }));
  }
  for (const [key, quality] of Object.entries(SHARE_AUDIO_QUALITIES)) {
    buildRadio($('share-audio-quality-options'), 'share-audio-quality', key, `${quality.label} · ${quality.detail}`, (audioQuality) => pickShareSetting({ audioQuality }));
  }

  $('share-menu-stop').addEventListener('click', () => {
    toggleShareMenu(false);
    engine.stopScreenShare();
  });

  $('share-menu-switch').addEventListener('click', async () => {
    toggleShareMenu(false);
    try {
      await engine.switchScreenShare();
      showToast('Transmissão alterada.');
    } catch (err) {
      if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') showToast('Não foi possível trocar a transmissão.');
    }
  });

  // Opens on click only, like the voice/video menus.
  shareMenuQuality.addEventListener('click', () => toggleQuality());

  shareMenuAudio.addEventListener('change', () => {
    const on = engine.setShareAudioEnabled(shareMenuAudio.checked);
    showToast(on ? 'Áudio da transmissão ativado.' : 'Áudio da transmissão silenciado.');
    renderShareMenu();
  });

  document.addEventListener('pointerdown', (e) => {
    if (isShown(shareMenu) && !shareMenu.contains(e.target) && !btnShareMenu.contains(e.target)) {
      toggleShareMenu(false);
    }
  });
  window.addEventListener('resize', () => toggleShareMenu(false));
  renderShareMenu();
}

function copyText(text, success) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => showToast(success)).catch(() => prompt(tr('Copie:'), text));
  } else {
    prompt(tr('Copie:'), text);
  }
}

function copyRoomInvite() {
  const code = engine.activeRoomId;
  if (!code) return;
  const url = `${location.origin}${location.pathname}?room=${code}`;
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    navigator.share({ title: 'Kennyy ScreenShare', text: tr(`Entre na minha sala: ${code}`), url }).catch(() => {});
    return;
  }
  copyText(url, `Link da sala copiado (${code}).`);
}

// The room code at the top opens a small menu: copy the code or the invite link.
const roomCodeMenu = $('room-code-menu');
function toggleRoomCodeMenu(open) {
  if (!roomCodeMenu || !btnCopyRoomCode) return;
  if (open) {
    const r = btnCopyRoomCode.getBoundingClientRect();
    roomCodeMenu.style.left = `${Math.max(8, r.left)}px`;
    roomCodeMenu.style.top = `${r.bottom + 6}px`;
    fadeShow(roomCodeMenu);
  } else {
    fadeHide(roomCodeMenu);
  }
  btnCopyRoomCode.setAttribute('aria-expanded', String(!!open));
}
btnCopyRoomCode?.addEventListener('click', () => {
  if (engine.activeRoomId) toggleRoomCodeMenu(!isShown(roomCodeMenu));
});
$('room-menu-copy-code')?.addEventListener('click', () => {
  toggleRoomCodeMenu(false);
  if (engine.activeRoomId) copyText(engine.activeRoomId, `Código copiado: ${engine.activeRoomId}`);
});
$('room-menu-copy-link')?.addEventListener('click', () => {
  toggleRoomCodeMenu(false);
  copyRoomInvite();
});
document.addEventListener('pointerdown', (e) => {
  if (isShown(roomCodeMenu) && !roomCodeMenu.contains(e.target) && !btnCopyRoomCode.contains(e.target)) toggleRoomCodeMenu(false);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isShown(roomCodeMenu)) toggleRoomCodeMenu(false); });
window.addEventListener('resize', () => toggleRoomCodeMenu(false));

// Discord: while a stream you watch is focused, the red button stops watching it instead of
// leaving the call.
function focusedWatchedStream() {
  const [pid, kind] = String(activeSpotlightId || '').split(':');
  return currentViewMode === 'spotlight' && kind === 'screen' && pid !== 'local' && (engine.watching.has(pid) || endedStreams.has(pid)) ? pid : null;
}

function paintEndcallButton() {
  if (!btnDockEndcall) return;
  const watching = !!focusedWatchedStream();
  btnDockEndcall.classList.toggle('stop-watch', watching);
  btnDockEndcall.title = watching ? 'Parar de assistir' : 'Sair da sala';
  btnDockEndcall.setAttribute('aria-label', btnDockEndcall.title);
}

btnDockEndcall?.addEventListener('click', async () => {
  const watched = focusedWatchedStream();
  if (watched) {
    stopWatching(watched);
    return;
  }
  const leave = await confirmDialog({ title: 'Sair da chamada?', message: 'Você será desconectado e voltará para a tela inicial.', confirmLabel: 'Sair', danger: true });
  if (!leave) return;
  leaveCurrentRoom();
  showToast('Você saiu da sala.');
});

function leaveCurrentRoom({ keepUrl = false } = {}) {
  closeProfile();
  if (engine.activeRoomId) playSound('leave');
  engine.leaveRoom();
  closeAllPopouts();
  clearAllEndedStreams();
  chatFiles.clear();
  isLocalSharing = false;
  localStream = null;
  activeSpotlightId = null;
  pinnedSpotlight = false;
  for (const id of [...audioPipelines.keys()]) removeAudioPipeline(id);
  if (stageGridView) stageGridView.innerHTML = '';
  if (participantsStrip) participantsStrip.innerHTML = '';
  setMicButton(true);
  setCameraButton(false);
  releaseWakeLock();
  if (!keepUrl) setRoomInUrl(null);
  updateNavigation();
}

// ==========================================================================
// DIAGNOSTICS & TELEMETRY MODAL
// ==========================================================================

// Admin panel, laid out like the Kennyy bot's admin panel: side nav with sections, KPI tiles
// and cards. Server numbers come from /api/admin/stats (the server checks the account too);
// "Esta sala" comes from the WebRTC engine.
let adminStatsTimer = null;
let adminData = null;
let adminPeers = [];
let adminSection = 'overview';
const fmtBytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`);
const fmtUptime = (s) => (s >= 86400 ? `${Math.floor(s / 86400)}d ${Math.floor(s % 86400 / 3600)}h` : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}min` : `${Math.floor(s / 60)}min`);
const fmtMinutes = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${Math.round(m % 60)}min` : `${Math.round(m)} min`);

const ADMIN_SECTIONS = {
  overview: { title: 'Visão geral', group: '' },
  connections: { title: 'Conexões', group: 'Esta sala' },
  log: { title: 'Registro', group: 'Esta sala' },
  rooms: { title: 'Salas', group: 'Servidor' },
  turn: { title: 'TURN (legado)', group: 'Servidor' },
  sfu: { title: 'Servidores de mídia', group: 'Servidor' },
  system: { title: 'Sistema', group: 'Sistema' }
};
const ADMIN_ICON_USERS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M17 11a4 4 0 0 0 0-8M22 21a7 7 0 0 0-4-6.3"/></svg>';
const ADMIN_ICON_LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
const ADMIN_ICON_RELAY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 7h10v10"/><path d="M7 17 17 7"/></svg>';

const adminEmpty = (text) => `<p class="admin-empty">${escapeHtml(text)}</p>`;
const adminInitial = (name) => escapeHtml((String(name || '?').trim().charAt(0) || '?').toUpperCase());
function adminRow({ icon, title, sub = '', subClass = '', meta = '' }) {
  return `
    <div class="admin-row">
      <span class="admin-row-icon">${icon}</span>
      <span class="admin-row-copy">
        <span class="admin-row-title">${title}</span>
        ${sub ? `<span class="admin-row-sub ${subClass}">${sub}</span>` : ''}
      </span>
      <span class="admin-row-meta">${meta}</span>
    </div>`;
}
const adminFact = (label, value) => `<div class="admin-fact"><span class="admin-fact-label">${escapeHtml(label)}</span><span class="admin-fact-value">${value}</span></div>`;
const setText = (id, text) => { const el = $(id); if (el) el.textContent = text; };

function roomRow(r) {
  return adminRow({
    icon: r.locked ? ADMIN_ICON_LOCK : ADMIN_ICON_USERS,
    title: `${escapeHtml(r.id)}${r.locked ? ' <small>· com senha</small>' : ''}`,
    sub: (r.members || []).map(m => `${escapeHtml(m.name)}${m.route === 'turn' ? ' <span class="admin-route turn">TURN</span>' : ''}`).join(', ') || 'Ninguém',
    meta: [
      r.p2p ? `<span class="admin-chip ok">${r.p2p} P2P</span>` : '',
      r.turn ? `<span class="admin-chip relay">${r.turn} TURN</span>` : '',
      r.sfu ? `<span class="admin-chip ok">${r.sfu} SFU</span>` : '',
      r.mode === 'sfu' ? `<span class="admin-chip relay" title="${escapeHtml(r.modeReason || '')}">SFU${r.node ? ` · ${escapeHtml(r.node)}` : ''}</span>` : '',
      `<span class="admin-chip">${r.people}${r.maxPeers ? `/${r.maxPeers}` : ''} ${r.people === 1 && !r.maxPeers ? 'pessoa' : 'pessoas'}</span>`,
      `<span class="admin-chip accent">${fmtMinutes(r.minutes)}</span>`
    ].join('')
  });
}

function peerChip(p) {
  const statusLabels = { connected: 'Conectado', connecting: 'Conectando', reconnecting: 'Reconectando', failed: 'Sem conexão' };
  if (p.status !== 'connected') return `<span class="admin-chip warn">${escapeHtml(statusLabels[p.status] || p.status)}</span>`;
  return p.route === 'TURN' ? '<span class="admin-chip relay">TURN</span>' : `<span class="admin-chip ok">${p.route || 'P2P'}</span>`;
}

function setAdminSection(section) {
  if (!ADMIN_SECTIONS[section]) section = 'overview';
  adminSection = section;
  const info = ADMIN_SECTIONS[section];
  for (const link of diagnosticsModal.querySelectorAll('.admin-nav-link')) {
    const on = link.dataset.section === section;
    link.classList.toggle('active', on);
    if (on) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  for (const el of diagnosticsModal.querySelectorAll('.admin-section')) el.classList.toggle('hidden', el.dataset.section !== section);
  setText('admin-title', info.title);
  setText('admin-crumb', ['Painel admin', info.group !== info.title ? info.group : '', section === 'overview' ? '' : info.title].filter(Boolean).join(' / '));
  diagnosticsModal.querySelector('.admin-main-body').scrollTop = 0;
  if (section === 'log' && logConsole) logConsole.scrollTop = logConsole.scrollHeight;
  if (section === 'sfu') renderAdminSfu();
}

diagnosticsModal?.addEventListener('click', (e) => {
  const target = e.target.closest('[data-section].admin-nav-link, [data-goto]');
  if (target) setAdminSection(target.dataset.goto || target.dataset.section);
});

async function refreshAdminStats() {
  try {
    const [res, sfuRes] = await Promise.all([
      fetch('/api/admin/stats', { credentials: 'same-origin', cache: 'no-store' }),
      fetch(`/api/admin/sfu?range=${sfuRange}`, { credentials: 'same-origin', cache: 'no-store' }).catch(() => null)
    ]);
    if (!res.ok) return;
    adminData = await res.json();
    if (sfuRes?.ok) sfuData = await sfuRes.json();
  } catch { return; }
  renderAdminPanel();
}

function renderAdminPanel() {
  renderAdminServer();
  renderAdminSfu();
  renderAdminOverview();
}

// --------------------------------------------------------------------------
// Admin: media servers (SFU nodes). Server side in server/sfu-nodes.js.
// --------------------------------------------------------------------------
let sfuData = null;
let sfuRange = '1h';
let sfuEditing = null; // node id being edited, '' = new node, null = form closed

const fmtRate = (kbps) => (kbps >= 1000 ? `${(kbps / 1000).toFixed(kbps >= 100000 ? 0 : 1)} Mbps` : `${Math.round(kbps || 0)} kbps`);
const fmtBytesShort = (n) => (n >= 1e12 ? `${(n / 1e12).toFixed(2)} TB` : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(0)} MB`);
const SFU_STATE = {
  ok: ['ok', 'Saudável', 'is-ok'],
  auth: ['warn', 'Secret recusado', 'is-bad'],
  down: ['warn', 'Fora do ar', 'is-bad'],
  unknown: ['', 'Verificando…', 'is-off']
};

async function adminPost(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// Line chart of traffic (kbps): exit (to viewers) as a filled line, entry (from streamers) as a
// thin one. points: [[time, inKbps, outKbps, people], ...]. Hover shows the values.
function drawTrafficChart(el, points, { small = false } = {}) {
  if (!el) return;
  const width = Math.max(200, el.clientWidth || 600);
  const height = el.clientHeight || (small ? 90 : 200);
  const pad = { l: small ? 0 : 52, r: 6, t: 8, b: small ? 4 : 20 };
  if (!points?.length) {
    el.innerHTML = `<svg viewBox="0 0 ${width} ${height}"><text class="empty" x="${width / 2}" y="${height / 2}" text-anchor="middle">Sem dados ainda</text></svg>`;
    return;
  }
  const max = Math.max(100, ...points.map(p => Math.max(p[1], p[2])));
  // A round top: 1, 2 or 5 × 10^n kbps.
  const step = 10 ** Math.floor(Math.log10(max));
  const top = [1, 2, 5, 10].map(k => k * step).find(v => v >= max) || max;
  const t0 = points[0][0];
  const t1 = Math.max(points[points.length - 1][0], t0 + 1);
  const x = (t) => pad.l + (t - t0) / (t1 - t0) * (width - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v / top) * (height - pad.t - pad.b);
  const path = (i) => points.map((p, k) => `${k ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[i]).toFixed(1)}`).join('');
  const area = `${path(2)}L${x(points[points.length - 1][0]).toFixed(1)},${y(0)}L${x(t0).toFixed(1)},${y(0)}Z`;
  let grid = '';
  if (!small) {
    for (const f of [0, 0.5, 1]) {
      grid += `<line class="grid" x1="${pad.l}" x2="${width - pad.r}" y1="${y(top * f)}" y2="${y(top * f)}"/>`;
      grid += `<text class="axis" x="${pad.l - 8}" y="${y(top * f) + 3}" text-anchor="end">${fmtRate(top * f)}</text>`;
    }
    const time = (t) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    grid += `<text class="axis" x="${pad.l}" y="${height - 4}">${time(t0)}</text>`;
    grid += `<text class="axis" x="${width - pad.r}" y="${height - 4}" text-anchor="end">${time(t1)}</text>`;
  }
  el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${grid}<path class="area-out" d="${area}"/><path class="line-in" d="${path(1)}"/><path class="line-out" d="${path(2)}"/><line class="cursor" y1="${pad.t}" y2="${height - pad.b}" visibility="hidden"/></svg><div class="sfu-tip hidden"></div>`;
  const svg = el.querySelector('svg');
  const cursor = el.querySelector('.cursor');
  const tip = el.querySelector('.sfu-tip');
  el.onmousemove = (e) => {
    const box = svg.getBoundingClientRect();
    const t = t0 + ((e.clientX - box.left) * width / box.width - pad.l) / (width - pad.l - pad.r) * (t1 - t0);
    let best = points[0];
    for (const p of points) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
    const cx = x(best[0]);
    cursor.setAttribute('x1', cx);
    cursor.setAttribute('x2', cx);
    cursor.setAttribute('visibility', 'visible');
    tip.classList.remove('hidden');
    tip.innerHTML = `${new Date(best[0]).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: sfuRange === '1h' ? '2-digit' : undefined })}<br><b>↑ ${fmtRate(best[2])}</b> saída · ↓ ${fmtRate(best[1])} entrada${best[3] != null ? `<br>${best[3]} ${best[3] === 1 ? 'pessoa' : 'pessoas'}` : ''}`;
    const left = cx * box.width / width;
    tip.style.left = `${Math.min(Math.max(0, left + 10), box.width - tip.offsetWidth)}px`;
  };
  el.onmouseleave = () => {
    cursor.setAttribute('visibility', 'hidden');
    tip.classList.add('hidden');
  };
}

// Daily totals of the last 14 days as bars.
function renderTrafficDays(el, days) {
  if (!el) return;
  const list = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    list.push([d, days?.[d] || 0]);
  }
  const max = Math.max(1, ...list.map(d => d[1]));
  el.innerHTML = list.map(([d, bytes], i) => `
    <div class="sfu-day${i === list.length - 1 ? ' today' : ''}" title="${d.split('-').reverse().join('/')}: ${fmtBytesShort(bytes)}">
      <div class="sfu-day-bar" style="height:${Math.max(2, bytes / max * 44)}px"></div>
      <span>${d.slice(8)}</span>
    </div>`).join('');
}

// Lists are redrawn every refresh; not while the admin is using a control inside them.
const sfuBusy = (el) => el?.contains(document.activeElement) && document.activeElement !== el;

function sfuNodeOptions(exclude, { usableOnly = true } = {}) {
  return (sfuData?.nodes || [])
    .filter(n => n.id !== exclude && (!usableOnly || (n.enabled && n.health.state === 'ok')))
    .map(n => `<option value="${escapeHtml(n.id)}">${escapeHtml(n.name)}</option>`).join('');
}

function renderSfuNode(n) {
  const [chip, label, dot] = SFU_STATE[n.health.state] || SFU_STATE.unknown;
  const week = Object.entries(n.days || {}).filter(([d]) => Date.now() - Date.parse(d) < 7 * 86400000).reduce((sum, [, b]) => sum + b, 0);
  const targets = sfuNodeOptions(n.id);
  return `
    <div class="sfu-node${n.enabled ? '' : ' is-disabled'}" data-node="${escapeHtml(n.id)}">
      <div class="sfu-node-head">
        <span class="admin-dash-dot ${dot}"></span>
        <span class="sfu-node-name">${escapeHtml(n.name)}</span>
        <span class="sfu-node-url">${escapeHtml(n.url)}</span>
        <span class="sfu-node-chips">
          <span class="admin-chip ${chip}">${label}</span>
          ${n.health.latencyMs != null && n.health.state === 'ok' ? `<span class="admin-chip">${n.health.latencyMs} ms</span>` : ''}
          ${n.enabled ? '' : '<span class="admin-chip warn">Não recebe salas novas</span>'}
          <span class="admin-chip" title="Chave da API · fim do secret">${escapeHtml(n.key)} · ${escapeHtml(n.secretHint)}</span>
        </span>
      </div>
      ${n.health.error ? `<p class="sfu-node-error">${escapeHtml(n.health.error)}</p>` : ''}
      <div class="sfu-node-stats">
        <div class="sfu-stat"><span>Saída agora</span><b>${fmtRate(n.now.outKbps)}</b></div>
        <div class="sfu-stat"><span>Entrada agora</span><b>${fmtRate(n.now.inKbps)}</b></div>
        <div class="sfu-stat"><span>Salas / pessoas</span><b>${n.rooms.length} / ${n.people}</b></div>
        <div class="sfu-stat"><span>No LiveKit</span><b>${n.health.liveRooms ?? '–'} / ${n.health.liveParticipants ?? '–'}</b></div>
        <div class="sfu-stat"><span>Hoje</span><b>${fmtBytesShort(n.todayBytes)}</b></div>
        <div class="sfu-stat"><span>7 dias</span><b>${fmtBytesShort(week)}</b></div>
      </div>
      <div class="sfu-chart small" data-chart="${escapeHtml(n.id)}"></div>
      <div class="sfu-node-actions">
        <button type="button" class="sfu-btn" data-act="test">Testar agora</button>
        <button type="button" class="sfu-btn" data-act="edit">Editar</button>
        <button type="button" class="sfu-btn" data-act="toggle">${n.enabled ? 'Parar de receber salas' : 'Voltar a receber salas'}</button>
        ${n.rooms.length ? `<span class="sfu-move"><select class="sfu-select" data-move-to ${targets ? '' : 'disabled'}>${targets || '<option>Nenhum outro nó saudável</option>'}</select><button type="button" class="sfu-btn" data-act="move-all" ${targets ? '' : 'disabled'}>Mover ${n.rooms.length === 1 ? 'a sala' : `as ${n.rooms.length} salas`}</button></span>` : ''}
        <span class="sfu-spacer"></span>
        <button type="button" class="sfu-btn danger" data-act="delete">Remover</button>
      </div>
    </div>`;
}

function renderSfuRoom(r) {
  const nodes = sfuData?.nodes || [];
  const node = nodes.find(n => n.id === r.node);
  const sub = [
    r.mode === 'sfu' ? `SFU em ${escapeHtml(node?.name || 'nenhum nó')}` : 'P2P',
    r.reason ? escapeHtml(r.reason) : '',
    r.hold ? `<span class="limited">no SFU porque: ${escapeHtml(r.hold)}</span>` : '',
    r.failedPairs?.length ? `<span class="limited">sem P2P: ${r.failedPairs.map(([a, b]) => `${escapeHtml(a)} ↔ ${escapeHtml(b)}`).join(', ')}</span>` : '',
    // Network type each person reported: symmetric/blocked can't do direct P2P.
    r.nets?.some(([, n]) => n !== '?') ? `redes: ${r.nets.map(([name, n]) => `${escapeHtml(name)} ${n === '?' ? '?' : escapeHtml({ cone: 'comum', symmetric: 'simétrica', blocked: 'sem UDP', relay: 'relay forçado' }[n.split('+')[0]] || n)}${n.includes('+v6') ? ' (IPv6)' : ''}`).join(', ')}` : ''
  ].filter(Boolean).join(' · ');
  const others = sfuNodeOptions(r.node);
  return adminRow({
    icon: ADMIN_ICON_USERS,
    title: `${escapeHtml(r.id)} <small>· ${r.people} ${r.people === 1 ? 'pessoa' : 'pessoas'}</small>`,
    sub,
    meta: `<span class="sfu-room-actions" data-room="${escapeHtml(r.id)}">
      <span class="admin-chip ${r.mode === 'sfu' ? 'relay' : 'ok'}">${r.mode === 'sfu' ? 'SFU' : 'P2P'}</span>
      <select class="sfu-select" data-room-mode title="Modo da sala">
        <option value="" ${!r.lock ? 'selected' : ''}>Automático</option>
        <option value="sfu" ${r.lock === 'sfu' ? 'selected' : ''}>Sempre SFU</option>
        <option value="mesh" ${r.lock === 'mesh' ? 'selected' : ''}>Sempre P2P</option>
      </select>
      ${r.mode === 'sfu' && others ? `<select class="sfu-select" data-move-to>${others}</select><button type="button" class="sfu-btn" data-act="move-room">Mover</button>` : ''}
    </span>`
  });
}

function renderAdminSfu() {
  if (!sfuData) return;
  const { nodes, total, rooms, settings } = sfuData;
  const bad = nodes.filter(n => n.health.state === 'down' || n.health.state === 'auth').length;
  setText('admin-badge-sfu', bad ? `${bad}!` : nodes.length ? `${nodes.length}` : '');
  setText('admin-sfu-healthy', nodes.length ? `${total.healthy}/${nodes.length}` : '0');
  setText('admin-sfu-out', fmtRate(total.now.outKbps));
  setText('admin-sfu-in', fmtRate(total.now.inKbps));
  setText('admin-sfu-today', fmtBytesShort(total.todayBytes));
  setText('admin-sfu-rooms-kpi', `${total.sfuRooms} / ${total.meshRooms}`);
  if (adminSection !== 'sfu') return;
  drawTrafficChart($('admin-sfu-chart-total'), sfuData.series._total);
  renderTrafficDays($('admin-sfu-days'), total.days);
  const list = $('admin-sfu-nodes');
  if (!sfuBusy(list)) {
    list.innerHTML = nodes.length
      ? nodes.map(renderSfuNode).join('')
      : adminEmpty('Nenhum nó cadastrado: todas as salas usam só P2P direto, e quem não conecta fica sem conexão. Adicione um LiveKit acima.');
    for (const n of nodes) drawTrafficChart(list.querySelector(`[data-chart="${CSS.escape(n.id)}"]`), sfuData.series[n.id], { small: true });
  }
  const roomList = $('admin-sfu-rooms');
  if (!sfuBusy(roomList)) roomList.innerHTML = rooms.length ? rooms.map(renderSfuRoom).join('') : adminEmpty('Nenhuma sala com gente agora.');
  const form = $('admin-sfu-settings');
  if (!sfuBusy(form) && !form.dataset.dirty) {
    form.meshMax.value = settings.meshMax;
    form.meshReturn.checked = !!settings.meshReturn;
    form.autoFailover.checked = !!settings.autoFailover;
    form.predictP2P.checked = settings.predictP2P !== false;
  }
  setText('admin-sfu-storage', `Nós e regras ficam salvos em ${sfuData.storage} (sobrevive a reinícios e deploys).`);
}

function openSfuForm(node) {
  const form = $('admin-sfu-form');
  sfuEditing = node ? node.id : '';
  form.reset();
  form.url.value = node?.url || '';
  form.name.value = node?.name || '';
  form.key.value = node && node.key !== 'kscreen' ? node.key : '';
  form.secret.placeholder = node ? `Vazio = manter o atual (${node.secretHint})` : 'LIVEKIT_API_SECRET do nó';
  form.secret.required = !node;
  setText('admin-sfu-form-title', node ? `Editar ${node.name}` : 'Novo nó');
  setText('admin-sfu-form-hint', node
    ? 'Mudar endereço, chave ou secret reconecta na hora quem está nas salas deste nó.'
    : 'O nó é testado ao salvar. A chave padrão é a que o install-livekit.sh gera (kscreen).');
  const result = $('admin-sfu-form-result');
  result.textContent = '';
  result.className = 'sfu-form-result';
  form.classList.remove('hidden');
  form.url.focus();
}

function closeSfuForm() {
  sfuEditing = null;
  $('admin-sfu-form').classList.add('hidden');
}

function nodeResultText(node) {
  const h = node.health;
  if (h.state === 'ok') return [`Saudável: respondeu em ${h.latencyMs} ms${h.liveRooms ? ` (${h.liveRooms} salas no LiveKit)` : ''}.`, 'ok'];
  return [`Salvo, mas ${h.state === 'auth' ? 'o secret ou a chave foram recusados' : 'o nó não respondeu'}: ${h.error}`, 'bad'];
}

$('btn-sfu-add')?.addEventListener('click', () => openSfuForm(null));
$('admin-sfu-cancel')?.addEventListener('click', closeSfuForm);
$('admin-sfu-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const result = $('admin-sfu-form-result');
  const save = $('admin-sfu-save');
  const body = { url: form.url.value.trim(), name: form.name.value.trim(), key: form.key.value.trim() };
  if (form.secret.value) body.secret = form.secret.value;
  save.disabled = true;
  result.className = 'sfu-form-result';
  result.textContent = 'Salvando e testando…';
  try {
    const data = await adminPost(sfuEditing ? `/api/admin/sfu/nodes/${sfuEditing}` : '/api/admin/sfu/nodes', body);
    const [text, cls] = nodeResultText(data.node);
    showToast(`${data.node.name}: ${text}${data.reconnecting ? ` ${data.reconnecting} sala(s) reconectando.` : ''}`, 5000);
    if (cls === 'ok') {
      closeSfuForm();
    } else {
      // Keep the form open on the saved node, so the admin can fix it.
      sfuEditing = data.node.id;
      form.secret.value = '';
      form.secret.required = false;
      result.className = `sfu-form-result ${cls}`;
      result.textContent = text;
    }
    await refreshAdminStats();
  } catch (err) {
    result.className = 'sfu-form-result bad';
    result.textContent = err.message;
  } finally {
    save.disabled = false;
  }
});

$('admin-sfu-nodes')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  const card = btn?.closest('[data-node]');
  if (!btn || !card) return;
  const node = sfuData?.nodes.find(n => n.id === card.dataset.node);
  if (!node) return;
  const act = btn.dataset.act;
  if (act === 'edit') return openSfuForm(node);
  try {
    btn.disabled = true;
    if (act === 'test') {
      const data = await adminPost(`/api/admin/sfu/nodes/${node.id}/test`);
      showToast(`${node.name}: ${nodeResultText(data.node)[0].replace(/^Salvo, mas /, 'Falhou: ')}`, 5000);
    } else if (act === 'toggle') {
      await adminPost(`/api/admin/sfu/nodes/${node.id}`, { enabled: !node.enabled });
      showToast(node.enabled ? `${node.name} não recebe mais salas novas (as atuais continuam nele).` : `${node.name} voltou a receber salas.`);
    } else if (act === 'move-all') {
      const to = card.querySelector('[data-move-to]')?.value;
      const data = await adminPost('/api/admin/sfu/migrate', { from: node.id, to });
      showToast(`${data.moved} sala(s) movida(s). As pessoas reconectam em alguns segundos.`);
    } else if (act === 'delete') {
      const others = sfuData.nodes.filter(n => n.id !== node.id && n.enabled && n.health.state === 'ok');
      const msg = node.rooms.length
        ? `Remover ${node.name}? ${others.length ? `As ${node.rooms.length} sala(s) nele vão para ${others[0].name}.` : 'Não há outro nó saudável: as salas nele voltam para P2P.'}`
        : `Remover ${node.name}?`;
      if (!confirm(msg)) return;
      const data = await adminPost(`/api/admin/sfu/nodes/${node.id}/delete`);
      showToast(`${node.name} removido${data.moved ? `; ${data.moved} sala(s) ${data.to ? `movidas para ${data.to}` : 'sem nó'}` : ''}.`);
    }
    await refreshAdminStats();
  } catch (err) {
    showToast(`Erro: ${err.message}`, 5000);
  } finally {
    btn.disabled = false;
  }
});

$('admin-sfu-rooms')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act="move-room"]');
  const box = btn?.closest('[data-room]');
  if (!box) return;
  try {
    btn.disabled = true;
    await adminPost('/api/admin/sfu/migrate', { roomId: box.dataset.room, to: box.querySelector('[data-move-to]').value });
    showToast(`Sala ${box.dataset.room} movida. As pessoas reconectam em alguns segundos.`);
    btn.blur();
    await refreshAdminStats();
  } catch (err) {
    showToast(`Erro: ${err.message}`, 5000);
  } finally {
    btn.disabled = false;
  }
});
$('admin-sfu-rooms')?.addEventListener('change', async (e) => {
  const select = e.target.closest('select[data-room-mode]');
  const box = select?.closest('[data-room]');
  if (!box) return;
  try {
    const data = await adminPost('/api/admin/sfu/room-mode', { roomId: box.dataset.room, mode: select.value || null });
    showToast(`Sala ${box.dataset.room}: ${select.value ? `sempre ${select.value === 'sfu' ? 'SFU' : 'P2P'}` : 'modo automático'} (agora em ${data.mode === 'sfu' ? 'SFU' : 'P2P'}).`);
  } catch (err) {
    showToast(`Erro: ${err.message}`, 5000);
  }
  select.blur();
  refreshAdminStats();
});

$('admin-sfu-settings')?.addEventListener('input', (e) => { e.currentTarget.dataset.dirty = '1'; });
$('admin-sfu-settings')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const result = $('admin-sfu-settings-result');
  try {
    await adminPost('/api/admin/sfu/settings', {
      meshMax: Number(form.meshMax.value),
      meshReturn: form.meshReturn.checked,
      autoFailover: form.autoFailover.checked,
      predictP2P: form.predictP2P.checked
    });
    delete form.dataset.dirty;
    result.className = 'sfu-form-result ok';
    result.textContent = 'Salvo. Vale para todas as salas agora.';
    refreshAdminStats();
  } catch (err) {
    result.className = 'sfu-form-result bad';
    result.textContent = err.message;
  }
});

for (const btn of document.querySelectorAll('.sfu-range-btn')) {
  btn.addEventListener('click', () => {
    sfuRange = btn.dataset.range;
    for (const b of document.querySelectorAll('.sfu-range-btn')) b.classList.toggle('active', b === btn);
    refreshAdminStats();
  });
}

function renderAdminServer() {
  if (!adminData) return;
  const { rooms, turn, server } = adminData;
  const turnOk = turn && !turn.error;
  setText('admin-rooms', `${rooms.active}`);
  setText('admin-people', `${rooms.people}`);
  // P2P / TURN come from what each browser reports about its own connections: the TURN server
  // alone can't tell a relay in use from one merely kept as a backup.
  setText('admin-p2p', `${rooms.p2p ?? '--'} / ${rooms.sfu ?? 0}`);
  setText('admin-turn-users', `${rooms.turn ?? '--'}`);
  setText('admin-badge-rooms', rooms.active ? `${rooms.active}` : '');
  setText('admin-badge-turn', rooms.turn ? `${rooms.turn}` : '');

  $('admin-rooms-table').innerHTML = rooms.list.length ? rooms.list.map(roomRow).join('') : adminEmpty('Nenhuma sala com gente agora.');
  $('admin-rooms-preview').innerHTML = rooms.list.length ? rooms.list.slice(0, 5).map(roomRow).join('') : adminEmpty('Nenhuma sala com gente agora.');

  // TURN
  setText('admin-turn-users-2', `${rooms.turn ?? '--'}`);
  setText('admin-turn-bytes', turnOk ? fmtBytes(turn.bytes_up + turn.bytes_down) : '--');
  setText('admin-turn-uptime', turnOk ? fmtUptime(turn.uptime_s) : '--');
  const traffic = new Map((turnOk ? turn.per_user : []).map(u => [u.id, u]));
  const viaTurn = rooms.list.flatMap(r => (r.members || []).filter(m => m.route === 'turn').map(m => ({ ...m, room: r.id })));
  $('admin-turn-table').innerHTML = viaTurn.length
    ? viaTurn.map(m => {
      const t = traffic.get(m.id);
      return adminRow({
        icon: adminInitial(m.name),
        title: escapeHtml(m.name),
        sub: `Sala ${escapeHtml(m.room)}${t ? ` · ↑ ${fmtBytes(t.bytes_up)} · ↓ ${fmtBytes(t.bytes_down)}` : ''}`,
        meta: `<span class="admin-chip relay">TURN</span>${t ? `<span class="admin-chip accent">${fmtMinutes(t.minutes)}</span>` : ''}`
      });
    }).join('')
    : adminEmpty(turnOk ? 'Ninguém passando pelo TURN: todo mundo está em P2P.' : `TURN: ${turn?.error || 'sem dados'}`);

  // Sistema
  $('admin-site-facts').innerHTML = [
    adminFact('No ar há', fmtUptime(server.uptimeS)),
    adminFact('Memória', `${server.memoryMb} MB`),
    adminFact('Salas com gente', `${rooms.active}`),
    adminFact('Pessoas conectadas', `${rooms.people}`)
  ].join('');
  $('admin-turn-facts').innerHTML = turnOk
    ? [
      adminFact('Status', '<span class="admin-chip ok">No ar</span>'),
      adminFact('No ar há', fmtUptime(turn.uptime_s)),
      adminFact('Pessoas via TURN', `${rooms.turn ?? 0}`),
      adminFact('Enviado / recebido', `${fmtBytes(turn.bytes_up)} / ${fmtBytes(turn.bytes_down)}`),
      turn.relay_ports ? adminFact('Portas de relay', `${turn.relay_ports[0]}–${turn.relay_ports[1]}`) : '',
      adminFact('Relógio', turn.clock_skew_s
        ? `<span class="admin-chip warn">${turn.clock_skew_s > 0 ? 'adiantado' : 'atrasado'} ${Math.abs(turn.clock_skew_s)}s</span>`
        : '<span class="admin-chip ok">Sincronizado</span>')
    ].join('')
    : [
      adminFact('Status', '<span class="admin-chip warn">Sem dados</span>'),
      adminFact('Motivo', escapeHtml(turn?.error || 'sem dados'))
    ].join('');
}

// The overview mixes server data with this room's connections.
function renderAdminOverview() {
  const turn = adminData?.turn;
  const turnOk = turn && !turn.error;
  const alerts = [];
  // TURN is legacy: only a configured one that broke is worth a warning.
  const turnConfigured = turn && !/não configurado/.test(turn.error || '');
  if (adminData && turnConfigured && !turnOk) alerts.push(`TURN (legado): ${turn?.error || 'sem dados'}`);
  if (adminData && sfuData && !sfuData.nodes.length) alerts.push('Nenhum servidor de mídia cadastrado: quem não consegue P2P direto fica sem conexão.');
  if (turnOk && turn.clock_skew_s) {
    alerts.push(`O relógio da VPS do TURN está ${turn.clock_skew_s > 0 ? 'adiantado' : 'atrasado'} ${Math.abs(turn.clock_skew_s)}s. Rode "sudo timedatectl set-ntp true" nela.`);
  }
  if (turnOk && turn.max_allocations && turn.allocations >= turn.max_allocations * 0.8) alerts.push(`TURN quase cheio: ${turn.allocations} de ${turn.max_allocations} relays.`);
  for (const n of sfuData?.nodes || []) {
    if (n.health.state === 'down' || n.health.state === 'auth') alerts.push(`Servidor de mídia ${n.name}: ${n.health.error || 'fora do ar'}`);
  }
  for (const p of adminPeers) {
    if (p.status !== 'connected') alerts.push(`${p.name}: ${p.status === 'reconnecting' ? 'reconectando' : p.status === 'failed' ? 'sem P2P direto (a sala vai para o SFU)' : 'ainda conectando'}.`);
    for (const flow of [p.sending, p.receiving]) {
      if (flow?.limitation === 'bandwidth') alerts.push(`${p.name}: vídeo limitado pela rede.`);
      else if (flow?.limitation === 'cpu') alerts.push(`${p.name}: vídeo limitado pelo processador.`);
    }
  }
  $('admin-attention').classList.toggle('hidden', !alerts.length);
  $('admin-alerts').innerHTML = alerts.map(a => `<div class="admin-alert">${escapeHtml(a)}</div>`).join('');

  $('admin-peers-preview').innerHTML = !engine.activeRoomId
    ? adminEmpty('Você não está em uma sala.')
    : adminPeers.length
      ? adminPeers.map(p => `
        <div class="admin-dash-node">
          <span class="admin-dash-dot ${p.status !== 'connected' ? 'is-warn' : p.isRelay ? 'is-relay' : 'is-ok'}"></span>
          <span class="admin-dash-node-name">${escapeHtml(p.name)}</span>
          <span class="admin-dash-node-meta">${escapeHtml(p.status === 'connected' ? `${p.route || (p.isRelay ? 'TURN' : 'P2P')}${p.pingMs ? ` · ${p.pingMs} ms` : ''}` : 'conectando')}</span>
        </div>`).join('')
      : adminEmpty('Ninguém mais na sala ainda.');

  const server = adminData?.server;
  $('admin-servers-preview').innerHTML = [
    `<div class="admin-dash-node"><span class="admin-dash-dot ${server ? 'is-ok' : 'is-off'}"></span><span class="admin-dash-node-name">Site</span><span class="admin-dash-node-meta">${server ? `no ar há ${fmtUptime(server.uptimeS)} · ${server.memoryMb} MB` : '--'}</span></div>`,
    !turnConfigured ? '' : `<div class="admin-dash-node"><span class="admin-dash-dot ${!adminData ? 'is-off' : turnOk ? (turn.clock_skew_s ? 'is-warn' : 'is-ok') : 'is-bad'}"></span><span class="admin-dash-node-name">TURN (legado)</span><span class="admin-dash-node-meta">${!adminData ? '--' : turnOk ? `no ar há ${fmtUptime(turn.uptime_s)}` : escapeHtml(turn?.error || 'sem dados')}</span></div>`,
    ...(sfuData?.nodes || []).map(n => `<div class="admin-dash-node" data-goto="sfu"><span class="admin-dash-dot ${(SFU_STATE[n.health.state] || SFU_STATE.unknown)[2]}"></span><span class="admin-dash-node-name">SFU ${escapeHtml(n.name)}</span><span class="admin-dash-node-meta">${n.health.state === 'ok' ? `${fmtRate(n.now.outKbps)} saindo · ${n.people} ${n.people === 1 ? 'pessoa' : 'pessoas'}` : escapeHtml((SFU_STATE[n.health.state] || SFU_STATE.unknown)[1])}</span></div>`)
  ].join('');
}

function openDiagnostics() {
  if (!currentUser?.admin) return;
  setAdminSection(engine.activeRoomId ? adminSection : (['connections', 'log'].includes(adminSection) ? 'overview' : adminSection));
  refreshAdminStats();
  clearInterval(adminStatsTimer);
  adminStatsTimer = setInterval(refreshAdminStats, 3000);
  diagnosticsModal?.classList.remove('hidden');
  renderTelemetryModal(engine.getPeersSummary());
  // Focus the panel itself (Esc / Tab work) without lighting up the close button.
  diagnosticsModal?.querySelector('.admin-shell')?.focus({ preventScroll: true });
}

function closeDiagnostics() {
  clearInterval(adminStatsTimer);
  adminStatsTimer = null;
  diagnosticsModal?.classList.add('hidden');
  btnOpenDiagnostics?.focus();
}

$('btn-admin-refresh')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.classList.add('spinning');
  renderTelemetryModal(engine.getPeersSummary());
  await Promise.all([refreshAdminStats(), new Promise(r => setTimeout(r, 500))]);
  btn.classList.remove('spinning');
});

btnOpenDiagnostics?.addEventListener('click', openDiagnostics);

// Secret: typing "kstatus" anywhere (outside a text field) opens / closes the connection status.
const SECRET_SEQUENCE = 'kstatus';
let secretTyped = '';
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
  if (e.target.closest?.('input, textarea, [contenteditable="true"]')) return;
  secretTyped = (secretTyped + e.key.toLowerCase()).slice(-SECRET_SEQUENCE.length);
  if (secretTyped !== SECRET_SEQUENCE) return;
  secretTyped = '';
  if (diagnosticsModal?.classList.contains('hidden')) openDiagnostics();
  else closeDiagnostics();
});
btnCloseDiagnostics?.addEventListener('click', closeDiagnostics);
diagnosticsModal?.addEventListener('click', (e) => {
  if (e.target === diagnosticsModal) closeDiagnostics();
});

// The connection panel no longer has a visible button: Ctrl+Shift+D opens it.
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd' && engine.activeRoomId) {
    e.preventDefault();
    if (diagnosticsModal?.classList.contains('hidden')) openDiagnostics();
    else closeDiagnostics();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (roomPasswordModal && !roomPasswordModal.classList.contains('hidden')) {
    closePasswordPrompt();
    return;
  }
  if (confirmModal && !confirmModal.classList.contains('hidden')) {
    settleConfirm(false);
    return;
  }
  if (createRoomModal && !createRoomModal.classList.contains('hidden')) {
    closeModal(createRoomModal);
    return;
  }
  if (isShown(shareMenu)) {
    if (!shareSubmenu.classList.contains('hidden')) {
      toggleQuality(false);
      shareMenuQuality.focus();
    } else {
      toggleShareMenu(false);
      btnShareMenu?.focus();
    }
  } else if (isShown(videoContextMenu)) closeContextMenu();
  else if (diagnosticsModal && !diagnosticsModal.classList.contains('hidden')) closeDiagnostics();
});

function renderTelemetryModal(peersList) {
  if (!telemetryPeersTable) return;
  adminPeers = peersList;
  const connected = peersList.filter(p => p.status === 'connected');
  const pings = connected.map(p => p.pingMs).filter(Boolean);
  const ping = pings.length ? `${Math.min(...pings)} ms` : '--';
  if (statsPing) statsPing.textContent = ping;
  setText('stats-ping-2', ping);
  setText('admin-badge-connections', peersList.length ? `${peersList.length}` : '');
  if (statsConnType) {
    const types = [...new Set(connected.map(p => p.route || (p.isRelay ? 'TURN' : 'P2P')))].sort();
    statsConnType.textContent = !engine.activeRoomId ? 'Fora de uma sala'
      : !peersList.length ? 'Aguardando participantes...'
        : types.length ? types.join(' e ') : 'Estabelecendo rotas...';
  }
  if (statsProtocol) statsProtocol.textContent = connected[0]?.protocol || '--';

  telemetryPeersTable.innerHTML = !engine.activeRoomId
    ? adminEmpty('Você não está em uma sala.')
    : !peersList.length
      ? adminEmpty('Ninguém mais na sala ainda. Compartilhe o link!')
      : peersList.map(p => {
        const flows = [describeFlow('Enviando', p.sending), describeFlow('Recebendo', p.receiving)].filter(Boolean);
        return adminRow({
          icon: p.isRelay ? ADMIN_ICON_RELAY : adminInitial(p.name),
          title: escapeHtml(p.name),
          sub: flows.length ? flows.map(f => escapeHtml(f.text)).join('<br>') : 'Sem vídeo agora',
          subClass: flows.some(f => f.limited) ? 'limited' : '',
          meta: `${peerChip(p)}<span class="admin-chip">${p.pingMs ? `${p.pingMs} ms` : '--'}</span>`
        });
      }).join('');
  renderAdminOverview();
}

// "Enviando 1920×1080 · 30 FPS · 4.2 Mbps · limitado pela rede"
function describeFlow(label, flow) {
  if (!flow || !flow.width) return null;
  const parts = [`${label} ${flow.width}×${flow.height}`];
  if (flow.fps != null) parts.push(`${flow.fps} FPS`);
  if (flow.kbps != null) parts.push(flow.kbps >= 1000 ? `${(flow.kbps / 1000).toFixed(1)} Mbps` : `${flow.kbps} kbps`);
  const limits = { bandwidth: 'limitado pela rede', cpu: 'limitado pelo processador' };
  const limited = limits[flow.limitation];
  if (limited) parts.push(limited);
  return { text: parts.join(' · '), limited: !!limited };
}

btnIceRestart?.addEventListener('click', () => {
  showToast('Renovando rotas com todos os participantes...');
  engine.restartIce();
});

btnOpenSecondTab?.addEventListener('click', () => {
  if (engine.activeRoomId) window.open(`/?room=${engine.activeRoomId}`, '_blank', 'noopener');
});

function appendLog(logItem) {
  if (!logConsole) return;
  const line = document.createElement('div');
  line.className = `log-line ${logItem.level || 'info'}`;
  line.textContent = `[${new Date(logItem.time).toLocaleTimeString()}] ${logItem.message}`;
  const atBottom = logConsole.scrollHeight - logConsole.scrollTop - logConsole.clientHeight < 24;
  logConsole.appendChild(line);
  while (logConsole.children.length > 300) logConsole.firstChild.remove();
  if (atBottom) logConsole.scrollTop = logConsole.scrollHeight;
}

// ==========================================================================
// SETTINGS WINDOW (src/settings.js): gear on the home screen and in the room, Ctrl+,
// Everything goes through the same functions as the dock menus, so both stay in sync.
// ==========================================================================

// Old switches ("forçar TURN", test block): gone, cleared from the browser.
try {
  localStorage.removeItem('kennyy_force_relay');
  localStorage.removeItem('kennyy_block_p2p');
} catch { /* storage blocked */ }
// Hidden settings row (Avançado): only shown after the Konami code, for this page.
let relayOptionShown = false;
const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
let konamiAt = 0;
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest?.('input, textarea, [contenteditable="true"]')) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  konamiAt = key === KONAMI[konamiAt] ? konamiAt + 1 : key === KONAMI[0] ? 1 : 0;
  if (konamiAt < KONAMI.length) return;
  konamiAt = 0;
  relayOptionShown = true;
  settings?.refresh?.('advanced');
});
let deafenedForMicTest = false;

const settings = initSettings({
  user: () => currentUser,
  avatar: (user) => safeAvatar(user?.avatarUrl),
  // New photo (Minha conta): same crop and limits as the guest login. Returns a data URL to
  // preview; nothing is kept until savePhoto.
  preparePhoto: async (file) => {
    if (!file?.type?.startsWith('image/')) throw new Error(tr('Escolha um arquivo de imagem.'));
    if (file.size > GUEST_PHOTO_MAX) throw new Error(tr('A foto pode ter no máximo 5 MB.'));
    const objectUrl = URL.createObjectURL(file);
    try {
      const img = await loadImage(objectUrl);
      if (!img.naturalWidth || !img.naturalHeight) throw new Error('empty');
      return squareAvatar(img);
    } catch {
      throw new Error(tr('Não foi possível ler essa imagem. Tente outro formato.'));
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  },
  // Keeps the photo in this browser and returns what the server signs ({ avatarHash, avatarSize }).
  savePhoto: async (dataUrl) => {
    const photo = await saveLocalAvatar(dataUrl);
    return { avatarHash: photo.hash, avatarSize: photo.size };
  },
  inRoom: () => !!engine.activeRoomId,
  logout,
  // Display name / profile colour (Minha conta). The server re-signs the session and updates
  // the rooms you are in, so the others see it on their next poll.
  updateProfile: async (changes) => {
    const res = await fetch('/api/auth/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.user) throw new Error(tr(data.error || 'Não foi possível salvar. Tente de novo.'));
    currentUser = data.user;
    updateNavigation();
    scheduleRender();
    return currentUser;
  },
  toast: (message) => showToast(message),
  confirm: (opts) => confirmDialog(opts),
  dialogOpen: () => !confirmModal?.classList.contains('hidden'),
  beforeOpen: () => {
    closeProfile();
    closeDeviceMenu();
    toggleShareMenu(false);
    closeContextMenu();
  },
  voice: {
    prefs: devicePrefs,
    canPickOutput,
    listDevices,
    ensureAccess: ensureDeviceAccess,
    needsAccess: async (kind) => {
      try {
        const want = kind === 'videoinput' ? 'videoinput' : 'audioinput';
        return !(await navigator.mediaDevices.enumerateDevices()).some(d => d.kind === want && d.label);
      } catch { return false; }
    },
    selectedId: (kind, items) => selectedDeviceId(kind, items),
    pick: (kind, id) => pickDevice(kind, id),
    setMicVolume: (v) => {
      devicePrefs.micVolume = v;
      engine.setMicVolume(v);
      saveDevicePrefs();
    },
    setOutVolume: (v) => {
      devicePrefs.outVolume = v;
      saveDevicePrefs();
      refreshGains();
    },
    setProcessing: (patch) => {
      Object.assign(devicePrefs, patch);
      saveDevicePrefs();
      engine.setMicProcessing(patch).catch(() => showToast('Não foi possível aplicar no microfone.'));
    },
    noiseFallback: () => !!engine.noiseFallback,
    audioContext: async () => {
      const ctx = getAudioContext();
      if (!ctx) throw new Error('no audio');
      await ctx.resume().catch(() => {});
      return ctx;
    },
    cameraStream: () => engine.cameraStream,
    openMicTest: () => engine.openMicTest({
      sinkId: canPickOutput && devicePrefs.out !== 'default' ? devicePrefs.out : '',
      outputVolume: devicePrefs.outVolume
    }),
    // The mic test deafens you in a room (you'd hear the room and yourself mixed) and undoes it
    // after, only if the test was what deafened you. Not saved, no sound cue.
    testDeafen: async (on) => {
      if (on) {
        if (!engine.activeRoomId || isAudioMuted) return;
        deafenedForMicTest = true;
        await setDeafened(true, { silent: true });
      } else if (deafenedForMicTest) {
        deafenedForMicTest = false;
        if (isAudioMuted) await setDeafened(false, { silent: true });
      }
    }
  },
  share: {
    RESOLUTIONS: SHARE_RESOLUTIONS,
    FPS: SHARE_FPS,
    AUDIO: SHARE_AUDIO_QUALITIES,
    get: () => engine.shareSettings,
    set: (change) => pickShareSetting(change),
    isLive: () => isLocalSharing,
    hasAudio: () => engine.hasShareAudio(),
    audioEnabled: () => engine.shareAudioEnabled,
    setAudioEnabled: (on) => {
      const now = engine.setShareAudioEnabled(on);
      showToast(now ? 'Áudio da transmissão ativado.' : 'Áudio da transmissão silenciado.');
      renderShareMenu();
    }
  },
  sounds: {
    CUES: SOUND_CUES,
    prefs: () => soundPrefs,
    set: (patch) => { Object.assign(soundPrefs, patch); saveSoundPrefs(); },
    setCue: (keys, on) => {
      const off = new Set(soundPrefs.off);
      for (const k of keys) { if (on) off.delete(k); else off.add(k); }
      soundPrefs.off = [...off];
      saveSoundPrefs();
    },
    preview: async (keys) => {
      const ctx = getAudioContext();
      if (!ctx) return;
      await ctx.resume().catch(() => {});
      keys.forEach((k, i) => setTimeout(() => playSound(k, { force: true }), i * 650));
    }
  },
  layout: {
    showNoVideo: () => showNoVideo,
    setShowNoVideo: (on) => {
      showNoVideo = on;
      if (ctxShowNoVideo) ctxShowNoVideo.checked = on;
      try { localStorage.setItem('kscreen.showNoVideo', on ? '1' : '0'); } catch { /* storage blocked */ }
      scheduleRender();
    },
    stripCollapsed: () => stripCollapsed,
    setStripCollapsed: (on) => {
      stripCollapsed = on;
      try { localStorage.setItem(STRIP_COLLAPSED_KEY, on ? '1' : '0'); } catch { /* private mode */ }
      scheduleLayout();
    },
    customVolumes: () => {
      try { return Object.keys(JSON.parse(localStorage.getItem('kennyy_audio_prefs') || '{}')).length; } catch { return 0; }
    },
    resetVolumes: () => {
      try { localStorage.removeItem('kennyy_audio_prefs'); } catch { /* storage blocked */ }
      refreshGains();
    }
  },
  language: {
    current: () => lang,
    choice: langChoice,
    set: setLangChoice,
    effective: effectiveLang,
    systemLabel: () => (systemLang() === 'pt' ? 'Português (do sistema)' : 'English (do sistema)')
  },
  advanced: {
    relayOptionShown: () => relayOptionShown,
    forceRelay: () => engine.forceRelay(),
    // Applied right away: the new network type goes to the server with the next poll, and the
    // room moves to (or, when nothing else blocks P2P, back from) the media server.
    setForceRelay: (on) => {
      try { if (on) localStorage.setItem(FORCE_RELAY_KEY, '1'); else localStorage.removeItem(FORCE_RELAY_KEY); } catch { /* storage blocked */ }
      engine.refreshNetwork(true);
      showToast(on ? 'Conexão via relay forçada.' : 'Conexão direta liberada.');
    },
    // Back to the defaults, applied live (mic, camera, output, share, sounds, layout).
    resetAll: async () => {
      Object.assign(devicePrefs, DEVICE_DEFAULTS);
      saveDevicePrefs();
      engine.setMicVolume(devicePrefs.micVolume);
      applyOutputDevice();
      await engine.setMicDevice('default').catch(() => {});
      await engine.setMicProcessing({ noiseSuppression: DEVICE_DEFAULTS.noiseSuppression, noiseStrength: DEVICE_DEFAULTS.noiseStrength, echoCancellation: DEVICE_DEFAULTS.echoCancellation }).catch(() => {});
      await engine.setCameraDevice('default').catch(() => {});
      try {
        saveShareSettings(await engine.setShareSettings({ ...DEFAULT_SHARE_SETTINGS }));
      } catch {
        saveShareSettings(DEFAULT_SHARE_SETTINGS); // the capture keeps its size; saved anyway
      }
      renderShareMenu();
      soundPrefs = { ...SOUND_DEFAULTS, off: [] };
      saveSoundPrefs();
      showNoVideo = true;
      if (ctxShowNoVideo) ctxShowNoVideo.checked = true;
      stripCollapsed = false;
      try {
        localStorage.removeItem('kscreen.showNoVideo');
        localStorage.removeItem(STRIP_COLLAPSED_KEY);
        localStorage.removeItem(FORCE_RELAY_KEY);
      } catch { /* storage blocked */ }
      engine.refreshNetwork(true);
      refreshGains();
      scheduleRender();
      scheduleLayout();
    }
  }
});

$('btn-home-settings')?.addEventListener('click', () => settings.open());
$('btn-room-settings')?.addEventListener('click', () => settings.open());
$('share-menu-settings')?.addEventListener('click', () => {
  toggleShareMenu(false);
  settings.open('share');
});

// ==========================================================================
// STARTUP
// ==========================================================================

const authError = new URLSearchParams(location.search).get('error');
if (authError) {
  showToast(AUTH_ERRORS[authError] || 'Não foi possível entrar com o Discord.', 6000);
  setRoomInUrl(new URLSearchParams(location.search).get('room'));
}
// Old builds kept a client-side (and forgeable) user here.
localStorage.removeItem('kennyy_discord_user');
localStorage.removeItem('kennyy_peer_name');

setMicButton(true);
fetchCurrentUser().then((user) => {
  currentUser = user;
  myNickname = displayNameOf(user);
  updateNavigation();
  joinFromUrl();
});
