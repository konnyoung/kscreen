'use strict';
/**
 * kScreen desktop: a thin native shell around the kScreen website.
 *
 * The UI, P2P engine, TURN and login all come from the site itself (one codebase to maintain).
 * The app adds what a browser cannot do:
 *  - native capture picker (screens + windows with live thumbnails) and system audio without the
 *    browser's "share audio" checkbox;
 *  - capture and encoding keep full speed while the window is minimized or covered;
 *  - no "you are sharing" bar, no tab throttling, deep links (kscreen://room/ID).
 */
const { app, BrowserWindow, WebContentsView, desktopCapturer, ipcMain, nativeTheme, screen, session, shell, Menu, webContents } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const platform = require('./platform');
// System language (Portuguese or English) for the few texts made here; pages translate themselves.
const i18n = require('./i18n');
const { tr } = i18n;

const DEFAULT_SERVER = 'https://screen.kennyy.com.br';
const PROTOCOL = 'kscreen';
const DEV = process.argv.includes('--dev') || !app.isPackaged && process.env.KSCREEN_DEV === '1';

// ---------------------------------------------------------------------------
// Chromium switches (must run before "ready")
// ---------------------------------------------------------------------------

// Keep capture, encoding and timers at full speed when the window is minimized or hidden behind
// a game: browsers throttle these, which is what makes a background share stutter.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// No forced GPU: on laptops with two GPUs (Intel/AMD + NVIDIA) the built-in display hangs off the
// integrated one, and screen/game capture (DXGI Desktop Duplication) fails when kScreen runs on
// the dedicated GPU; Chromium then falls back to a CPU capture that drops games to ~1 fps and
// stalls the screen. See tuneHybridGpu() below.
// Only the app's own UI uses autoplay (remote audio/video), never third-party pages.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Linux: GPU video encoding (VA-API) and PipeWire screen capture; native Wayland when available.
if (platform.chromiumFeatures?.length) app.commandLine.appendSwitch('enable-features', platform.chromiumFeatures.join(','));
if (process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
for (const [name, value] of platform.chromiumSwitches || []) {
  // enable-features is a single switch: join with the list above instead of replacing it.
  if (name === 'enable-features' && app.commandLine.hasSwitch(name)) {
    app.commandLine.appendSwitch(name, `${app.commandLine.getSwitchValue(name)},${value}`);
  } else if (value === undefined) {
    app.commandLine.appendSwitch(name);
  } else {
    app.commandLine.appendSwitch(name, value);
  }
}
// The mic's automatic gain control must stay inside the audio pipeline: without this, Chromium's
// AGC moves the system input volume (PulseAudio/PipeWire source, Windows mic level) up and down.
// kScreen's own input volume is the gain node in webrtc.js (openMic).
app.commandLine.appendSwitch('disable-features', 'WebRtcAllowInputVolumeAdjustment');

// ---------------------------------------------------------------------------
// Settings (userData/settings.json)
// ---------------------------------------------------------------------------

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
  } catch { /* read-only profile: settings just don't persist */ }
  return next;
}

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find(a => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

// Priority: --server=URL > KSCREEN_URL > settings.json "server" > default.
function serverUrl() {
  const raw = argValue('server') || process.env.KSCREEN_URL || loadSettings().server || DEFAULT_SERVER;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && !isLoopback(url.hostname)) throw new Error('https only');
    return url.origin;
  } catch {
    return DEFAULT_SERVER;
  }
}

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

const SERVER = serverUrl();
const SERVER_ORIGIN = new URL(SERVER).origin;

function isAppUrl(raw) {
  try {
    return new URL(raw).origin === SERVER_ORIGIN;
  } catch {
    return false;
  }
}

function isLoginUrl(raw) {
  try {
    const url = new URL(raw);
    return url.origin === SERVER_ORIGIN && url.pathname === '/api/auth/discord/login';
  } catch {
    return false;
  }
}

function openExternal(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:') shell.openExternal(url.href);
  } catch { /* ignore malformed links */ }
}

// ---------------------------------------------------------------------------
// Deep links: kscreen://room/ABC123 (or kscreen://ABC123) opens that room
// ---------------------------------------------------------------------------

function roomFromDeepLink(raw) {
  if (!raw || !raw.startsWith(`${PROTOCOL}://`)) return null;
  try {
    const url = new URL(raw);
    const parts = [url.hostname, ...url.pathname.split('/')].filter(Boolean);
    const room = url.searchParams.get('room') || (parts[0] === 'room' ? parts[1] : parts[0]);
    return room && /^[A-Za-z0-9_-]{1,64}$/.test(room) ? room : null;
  } catch {
    return null;
  }
}

function startUrl(room) {
  const url = new URL(SERVER);
  if (room) url.searchParams.set('room', room);
  return url.href;
}

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------

let mainWindow = null;   // frameless window; its own page is the title bar (titlebar.html)
let siteView = null;     // the kScreen site, below the title bar
const TITLEBAR_HEIGHT = 32;
const siteContents = () => (siteView && !siteView.webContents.isDestroyed() ? siteView.webContents : null);
let roomState = { room: null, locked: false };
let htmlFullscreen = false;
let pendingRoom = roomFromDeepLink(process.argv.find(a => a.startsWith(`${PROTOCOL}://`)));

function restoreBounds() {
  const saved = loadSettings().window;
  const fallback = { width: 1280, height: 800 };
  if (!saved || !saved.width || !saved.height) return fallback;
  // Only reuse the position if it is still on a connected monitor.
  const visible = screen.getAllDisplays().some(({ workArea: a }) =>
    saved.x >= a.x - 50 && saved.y >= a.y - 50 && saved.x < a.x + a.width - 100 && saved.y < a.y + a.height - 100);
  return visible ? saved : { width: saved.width, height: saved.height };
}

// Title bar state (maximize icon, focus dimming, room code + lock).
function sendTitlebarState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('titlebar:state', {
    maximized: mainWindow.isMaximized(),
    focused: mainWindow.isFocused(),
    room: roomState.room,
    locked: roomState.locked
  });
}

// The site fills the window below the title bar (all of it in fullscreen).
function layoutViews() {
  if (!mainWindow || mainWindow.isDestroyed() || !siteView) return;
  const [width, height] = mainWindow.getContentSize();
  const bar = mainWindow.isFullScreen() ? 0 : TITLEBAR_HEIGHT;
  siteView.setBounds({ x: 0, y: bar, width, height: Math.max(0, height - bar) });
}

function createMainWindow() {
  const bounds = restoreBounds();
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 380,
    minHeight: 520,
    show: false,
    title: 'kScreen',
    // Our own title bar and window buttons (like Discord) instead of the system frame.
    frame: false,
    backgroundColor: '#0b0c0e',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'titlebar-preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'titlebar.html'));

  siteView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      // The point of the app: never slow down a running share in the background.
      backgroundThrottling: false
    }
  });
  siteView.setBackgroundColor('#0b0c0e');
  mainWindow.contentView.addChildView(siteView);
  layoutViews();

  for (const event of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore']) {
    mainWindow.on(event, () => { layoutViews(); sendTitlebarState(); });
  }
  mainWindow.on('focus', sendTitlebarState);
  mainWindow.on('blur', sendTitlebarState);
  mainWindow.on('leave-full-screen', () => {
    // Esc/F11 out of the window's fullscreen also ends the page's fullscreen.
    if (htmlFullscreen) siteContents()?.executeJavaScript('document.fullscreenElement && document.exitFullscreen()').catch(() => {});
    htmlFullscreen = false;
  });

  // Maximize only once shown: maximizing a hidden window doesn't emit 'resize', so the site
  // view would keep the restored size until the next resize.
  mainWindow.once('ready-to-show', () => {
    if (loadSettings().window?.maximized) mainWindow.maximize();
    mainWindow.show();
    layoutViews();
    setTimeout(layoutViews, 100);
  });
  mainWindow.on('show', layoutViews);
  // Keep the app's name in the taskbar instead of each page's <title>.
  mainWindow.on('page-title-updated', (event) => event.preventDefault());
  const persist = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    const maximized = mainWindow.isMaximized();
    const prev = loadSettings().window || {};
    saveSettings({ window: maximized ? { ...prev, maximized } : { ...mainWindow.getNormalBounds(), maximized } });
  };
  mainWindow.on('close', persist);
  mainWindow.on('closed', () => {
    mainWindow = null;
    siteView = null;
  });

  const wc = siteView.webContents;

  // Fullscreen video in the site (the fullscreen button): fill the whole window, no title bar.
  wc.on('enter-html-full-screen', () => {
    htmlFullscreen = true;
    mainWindow.setFullScreen(true);
    layoutViews();
  });
  wc.on('leave-html-full-screen', () => {
    htmlFullscreen = false;
    mainWindow.setFullScreen(false);
    layoutViews();
  });

  // Links: app pages stay inside; everything else (Discord included) opens in the real browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (isLoginUrl(url)) {
      startBrowserLogin(url);
      return { action: 'deny' };
    }
    // Site files (chat images) open nowhere: the page saves them instead.
    if (isAppUrl(url) && /^\/api\//.test(new URL(url).pathname)) return { action: 'deny' };
    if (isAppUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          backgroundColor: '#0b0c0e',
          autoHideMenuBar: true,
          icon: path.join(__dirname, '..', 'build', 'icon.png'),
          webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false }
        }
      };
    }
    openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    if (isLoginUrl(url)) {
      // "Entrar com Discord": log in through the system browser, never inside this window.
      event.preventDefault();
      startBrowserLogin(url);
      return;
    }
    if (isAppUrl(url) || url.startsWith('file:')) return;
    event.preventDefault();
    openExternal(url);
  });
  // A server redirect can't take the window off the site either (e.g. to discord.com).
  wc.on('will-redirect', (event, url) => {
    if (isAppUrl(url) && !isLoginUrl(url)) return;
    event.preventDefault();
    if (isLoginUrl(url)) startBrowserLogin(url);
    else openExternal(url);
  });

  wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    // -3 = aborted (a redirect replaced the load); not an error.
    if (!isMainFrame || code === -3) return;
    wc.loadFile(path.join(__dirname, 'offline.html'), {
      query: { url: startUrl(pendingRoom), error: `${description} (${code})`, server: SERVER }
    });
  });

  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    if (key === 'f12' || (input.control && input.shift && key === 'i')) {
      wc.toggleDevTools();
      event.preventDefault();
    } else if (key === 'f5' || (input.control && key === 'r')) {
      wc.reload();
      event.preventDefault();
    } else if (key === 'f11') {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
      event.preventDefault();
    } else if (input.control && (key === '=' || key === '+')) {
      wc.setZoomLevel(Math.min(3, wc.getZoomLevel() + 0.5));
      event.preventDefault();
    } else if (input.control && key === '-') {
      wc.setZoomLevel(Math.max(-3, wc.getZoomLevel() - 0.5));
      event.preventDefault();
    } else if (input.control && key === '0') {
      wc.setZoomLevel(0);
      event.preventDefault();
    }
  });

  wc.loadURL(startUrl(pendingRoom));
  pendingRoom = null;
}

function openRoom(room) {
  if (!mainWindow) {
    pendingRoom = room;
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  if (room) siteContents()?.loadURL(startUrl(room));
}

// ---------------------------------------------------------------------------
// Native capture picker
// ---------------------------------------------------------------------------

let picker = null; // { window, resolve }

function closePicker(result) {
  if (!picker) return;
  const { window, resolve } = picker;
  picker = null;
  resolve(result);
  if (!window.isDestroyed()) window.close();
}

// Quality the site had selected when it opened the picker (share:prepare), per page.
const SHARE_RESOLUTIONS = ['480', '720', '1080', '1440', 'source'];
const SHARE_FPS = [15, 30, 60];
const SHARE_AUDIO_QUALITIES = ['standard', 'high', 'max'];
const sharePrepared = new Map(); // webContents id -> { resolution, fps }
const shareResults = new Map();  // webContents id -> { resolution, fps, audio } from the last pick

function cleanShareSettings(value) {
  const v = value || {};
  return {
    resolution: SHARE_RESOLUTIONS.includes(v.resolution) ? v.resolution : '1080',
    fps: SHARE_FPS.includes(Number(v.fps)) ? Number(v.fps) : 60,
    audioQuality: SHARE_AUDIO_QUALITIES.includes(v.audioQuality) ? v.audioQuality : 'max'
  };
}

ipcMain.on('share:prepare', (event, settings) => {
  if (!isAppUrl(event.sender.getURL())) return;
  sharePrepared.set(event.sender.id, cleanShareSettings(settings));
  shareResults.delete(event.sender.id);
});

ipcMain.handle('share:result', (event) => {
  const result = shareResults.get(event.sender.id) || null;
  shareResults.delete(event.sender.id);
  return result;
});

function openPicker(parent, { audioRequested, settings }) {
  if (picker) closePicker(null);
  return new Promise((resolve) => {
    const window = new BrowserWindow({
      parent,
      modal: true,
      width: 1000,
      height: 720,
      minWidth: 560,
      minHeight: 460,
      show: false,
      frame: false,
      resizable: false,
      backgroundColor: '#121316',
      title: tr('Compartilhar tela'),
      webPreferences: {
        preload: path.join(__dirname, 'picker-preload.js'),
        contextIsolation: true,
        sandbox: true
      }
    });
    picker = { window, resolve, audioRequested, settings };
    window.once('ready-to-show', () => window.show());
    window.on('closed', () => {
      if (picker?.window === window) closePicker(null);
    });
    window.webContents.on('will-navigate', e => e.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.loadFile(path.join(__dirname, 'picker.html'));
  });
}

function pickerSender(event) {
  return picker && event.sender === picker.window.webContents;
}

ipcMain.handle('picker:init', async (event) => {
  if (!pickerSender(event)) return null;
  const audioSupported = await platform.audio.supported();
  return {
    audioRequested: picker.audioRequested,
    audio: loadSettings().shareAudio !== false,
    systemAudio: audioSupported || platform.audio.fallbackLoopback,
    // Excluding apps needs our own capture (not the plain system loopback).
    appExclusion: audioSupported,
    // Wayland: the screen/window is picked in the system dialog, after our settings.
    systemPicker: platform.capture.systemPicker,
    settings: picker.settings,
    audioExclude: audioExcludeList()
  };
});

// Apps whose sound can be left out of the share (exe names, e.g. "Discord").
const EXE_NAME = /^[\w .()+-]{1,64}$/;
function audioExcludeList() {
  const list = loadSettings().audioExclude;
  return Array.isArray(list) ? list.filter(n => typeof n === 'string' && EXE_NAME.test(n)).slice(0, 32) : [];
}

// Apps that currently play sound (minus kScreen), from the platform module.
ipcMain.handle('picker:apps', async (event) => {
  if (!pickerSender(event) || !(await platform.audio.supported())) return [];
  const own = path.parse(process.execPath).name.toLowerCase();
  const running = await platform.audio.listApps(process.pid);
  const apps = running.filter(a => a && EXE_NAME.test(a.exe) && a.exe.toLowerCase() !== own && a.exe.toLowerCase() !== 'kscreen');
  // Keep showing excluded apps that are closed right now, so they can be un-excluded.
  for (const exe of audioExcludeList()) {
    if (!apps.some(a => a.exe.toLowerCase() === exe.toLowerCase())) apps.push({ exe, name: exe });
  }
  return apps.map(a => ({ exe: a.exe, name: String(a.name || a.exe).slice(0, 80) }));
});

ipcMain.handle('picker:sources', async (event) => {
  // With the system picker, listing sources would pop the system dialog on every refresh.
  if (!pickerSender(event) || platform.capture.systemPicker) return [];
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 640, height: 360 },
    fetchWindowIcons: true
  });
  const displays = screen.getAllDisplays();
  const ownHandles = new Set(BrowserWindow.getAllWindows().map(w => w.getMediaSourceId().split(':')[1]));
  return sources
    // Our own windows (picker, kScreen) would just show an infinite mirror.
    // (compare the window handle: the ids' trailing parts can differ)
    .filter(s => !(s.id.startsWith('window:') && ownHandles.has(s.id.split(':')[1])))
    .map((s, index) => {
      const display = s.display_id && displays.find(d => String(d.id) === String(s.display_id));
      const size = display ? `${Math.round(display.size.width * display.scaleFactor)}×${Math.round(display.size.height * display.scaleFactor)}` : null;
      return {
        id: s.id,
        type: s.id.startsWith('screen:') ? 'screen' : 'window',
        name: s.id.startsWith('screen:') && sources.filter(x => x.id.startsWith('screen:')).length > 1
          ? tr(`Tela ${index + 1}`)
          : s.id.startsWith('screen:') ? tr('Tela inteira') : s.name,
        detail: size,
        primary: display ? display.id === screen.getPrimaryDisplay().id : false,
        thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null
      };
    });
});

ipcMain.on('picker:choose', (event, choice) => {
  if (!pickerSender(event)) return;
  if (!choice || typeof choice.id !== 'string') return closePicker(null);
  const exclude = Array.isArray(choice.audioExclude) ? choice.audioExclude.filter(n => typeof n === 'string' && EXE_NAME.test(n)).slice(0, 32) : audioExcludeList();
  saveSettings({ shareAudio: !!choice.audio, audioExclude: exclude });
  closePicker({ id: choice.id, audio: !!choice.audio, ...cleanShareSettings(choice) });
});

ipcMain.on('picker:cancel', (event) => {
  if (pickerSender(event)) closePicker(null);
});

async function handleDisplayMedia(request, callback) {
  const frame = request.frame;
  const parent = frame && BrowserWindow.fromWebContents(webContents.fromFrame(frame)) || mainWindow;
  if (!frame || !isAppUrl(frame.url)) return callback(null);

  const pageId = webContents.fromFrame(frame).id;
  // share:prepare travels on another channel than getDisplayMedia: give it a moment to land.
  if (!sharePrepared.has(pageId)) await new Promise(r => setTimeout(r, 50));
  const choice = await openPicker(parent, { audioRequested: request.audioRequested, settings: sharePrepared.get(pageId) || cleanShareSettings() });
  sharePrepared.delete(pageId);
  if (!choice) return callback(null); // page sees NotAllowedError = "cancelled"

  // Re-resolve the source: the page must get the live object, not a stale id.
  // System picker (Wayland): this call shows the system dialog and returns the chosen source.
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
  const source = choice.id === 'system' ? sources[0] : sources.find(s => s.id === choice.id);
  if (!source) return callback(null);

  // Windows: fullscreen games are captured through their monitor (see platform/win.js), and
  // the video pauses (black) only while the game is minimized.
  stopGameWatch(pageId);
  let video = source;
  let game = false;
  if (platform.game && source.id.startsWith('window:')) {
    const display = await platform.game.fullscreenDisplayOf(source.id);
    const screenSource = display && sources.find(s => s.id.startsWith('screen:') && String(s.display_id) === String(display.id));
    if (screenSource) {
      video = screenSource;
      game = true;
      startGameWatch(pageId, webContents.fromFrame(frame), source.id);
    }
  }
  shareResults.set(pageId, { ...cleanShareSettings(choice), audio: choice.audio, game });
  const streams = { video };
  const wantsAudio = request.audioRequested && choice.audio;
  if (wantsAudio && await platform.audio.supported()) {
    // PC audio comes from the platform capture (without kScreen); the site asks for it next.
    audioGrants.set(pageId, Date.now());
  } else if (wantsAudio && platform.audio.fallbackLoopback) {
    // Old Windows (before 10 2004): plain system loopback, which also captures the room's voices.
    streams.audio = 'loopback';
  }
  callback(streams);
  boostSharePriority();
}

// A game that keeps the GPU at 100% (e.g. Minecraft with shaders) starves the GPU work of kScreen
// and the processes the capture pipeline runs in: the DXGI capture (browser/utility process), the
// WebRTC encoding (renderer) and the hardware encoder (GPU process). The share then drops to a few
// FPS while the game runs smoothly. Like OBS, raise the GPU scheduling priority (and CPU priority)
// of all of kScreen's processes: REALTIME holds ~58 FPS with the GPU at 99% (HIGH: ~31, normal:
// ~10). Done on every share: processes may have restarted.
async function boostSharePriority() {
  let pids = [];
  try { pids = app.getAppMetrics().map(m => m.pid); } catch { /* no metrics */ }
  if (!pids.length) return;
  const os = require('node:os');
  for (const pid of pids) {
    try { os.setPriority(pid, os.constants.priority.PRIORITY_ABOVE_NORMAL); } catch { /* not allowed */ }
  }
  if (platform.gpu?.boost && !(await platform.gpu.boost(pids))) console.log('[gpu] prioridade de GPU não aplicada');
  // Then REALTIME (after HIGH, which would otherwise overwrite it). Without the installer's task
  // (dev run, old install) HIGH is what's left.
  if (platform.gpu?.realtime && app.isPackaged && !(await platform.gpu.realtime())) console.log('[gpu] tarefa de prioridade REALTIME indisponível');
}

// ---------------------------------------------------------------------------
// Fullscreen game watch (Windows): black video while the game isn't in front
// ---------------------------------------------------------------------------

const gameWatches = new Map(); // page webContents id -> handle
const gameWatchPages = new WeakSet();

function startGameWatch(pageId, page, sourceId) {
  const handle = platform.game.watch(sourceId, (inFront) => {
    if (!page.isDestroyed()) page.send('share:paused', !inFront);
  });
  gameWatches.set(pageId, handle);
  handle.onExit(() => {
    if (gameWatches.get(pageId) === handle) gameWatches.delete(pageId);
  });
  if (!gameWatchPages.has(page)) {
    gameWatchPages.add(page);
    page.once('destroyed', () => stopGameWatch(pageId));
    // A reload ends the share; in-page URL changes (?room=) do not.
    page.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) stopGameWatch(pageId);
    });
  }
}

function stopGameWatch(pageId) {
  const handle = gameWatches.get(pageId);
  if (!handle) return;
  gameWatches.delete(pageId);
  handle.stop();
}

ipcMain.on('share:ended', (event) => stopGameWatch(event.sender.id));
app.on('will-quit', () => { for (const id of [...gameWatches.keys()]) stopGameWatch(id); });

// ---------------------------------------------------------------------------
// PC audio without echo: the platform capture leaves out this app (where the friends' voices
// play) and the apps the user excluded. Electron's own 'loopback' would capture everything.
// ---------------------------------------------------------------------------

const audioGrants = new Map();   // webContents id -> time the picker granted audio
const audioCaptures = new Map(); // webContents id -> capture handle
const watchedSenders = new WeakSet();

function stopSystemAudio(id) {
  const handle = audioCaptures.get(id);
  if (!handle) return;
  audioCaptures.delete(id);
  handle.stop();
}

ipcMain.handle('system-audio:start', (event) => {
  const id = event.sender.id;
  const granted = audioGrants.get(id);
  audioGrants.delete(id);
  // Only right after the user ticked "share audio" in the picker for this window.
  if (!granted || Date.now() - granted > 30000 || !isAppUrl(event.sender.getURL())) return null;
  stopSystemAudio(id);

  const handle = platform.audio.start({ selfPid: process.pid, exclude: audioExcludeList() });
  if (!handle) return null;
  audioCaptures.set(id, handle);
  const sender = event.sender;
  // Batch ~20 ms of PCM per message: fewer IPC hops, still low latency.
  let pending = [];
  let pendingBytes = 0;
  handle.stdout.on('data', (chunk) => {
    pending.push(chunk);
    pendingBytes += chunk.length;
    if (pendingBytes < 3840) return;
    const data = Buffer.concat(pending, pendingBytes);
    pending = [];
    pendingBytes = 0;
    if (!sender.isDestroyed()) sender.send('system-audio:data', data);
  });
  handle.onExit((code) => {
    if (audioCaptures.get(id) === handle) {
      audioCaptures.delete(id);
      if (!sender.isDestroyed()) sender.send('system-audio:ended', code);
    }
  });
  if (!watchedSenders.has(sender)) {
    watchedSenders.add(sender);
    sender.once('destroyed', () => stopSystemAudio(id));
    // Reload / leaving the page ends the share; in-page URL changes (?room=) do not.
    sender.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) stopSystemAudio(id);
    });
  }
  return { sampleRate: 48000, channels: 2, format: 's16' };
});

ipcMain.on('system-audio:stop', (event) => stopSystemAudio(event.sender.id));

app.on('will-quit', () => {
  for (const id of [...audioCaptures.keys()]) stopSystemAudio(id);
});

// ---------------------------------------------------------------------------
// Permissions: only our site gets camera/mic/screen/notifications
// ---------------------------------------------------------------------------

const ALLOWED_PERMISSIONS = new Set([
  'media', 'display-capture', 'fullscreen', 'notifications', 'clipboard-sanitized-write',
  'screen-wake-lock', 'speaker-selection', 'pointerLock', 'keyboardLock'
]);

function configureSession(ses) {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(ALLOWED_PERMISSIONS.has(permission) && isAppUrl(details.requestingUrl || wc.getURL()));
  });
  // Normalized: Electron may pass the origin with a trailing slash, which used to hide
  // the mic/camera/speaker list (enumerateDevices) from the site.
  ses.setPermissionCheckHandler((wc, permission, origin, details) =>
    ALLOWED_PERMISSIONS.has(permission) && isAppUrl(origin || details?.requestingUrl || wc?.getURL() || ''));
  ses.setDisplayMediaRequestHandler(handleDisplayMedia);
}

// Dev only: the local Vite server uses a self-signed certificate.
app.on('certificate-error', (event, _wc, url, _error, _cert, callback) => {
  const host = new URL(url).hostname;
  if (DEV && isLoopback(host)) {
    event.preventDefault();
    callback(true);
  } else {
    callback(false);
  }
});

// ---------------------------------------------------------------------------
// Login with Discord through the system browser (RFC 8252 + PKCE)
//
// The browser (where people are usually already logged in to Discord) does the OAuth. The site
// then sends the browser to http://127.0.0.1:<port>/kscreen-auth?code=..., this app's one-shot
// local server. The one-time code only becomes a session together with the verifier, which never
// leaves this process, so another program catching the code gets nothing.
// ---------------------------------------------------------------------------

const http = require('node:http');
const crypto = require('node:crypto');
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
let login = null; // { server, verifier, authUrl, returnTo, timer }

function cancelLogin() {
  if (!login) return;
  clearTimeout(login.timer);
  login.server.close();
  login.server.closeAllConnections?.();
  login = null;
}

let brandFontDataUrl = null;
function brandFont() {
  // Embedded: the one-shot local server closes right after answering, so no second request.
  try {
    brandFontDataUrl ??= `data:font/ttf;base64,${fs.readFileSync(path.join(__dirname, 'fonts', 'K2D-Bold.ttf')).toString('base64')}`;
  } catch {
    brandFontDataUrl = '';
  }
  return brandFontDataUrl;
}

function loginDonePage(ok, message) {
  const font = brandFont();
  return `<!doctype html><html lang="${i18n.lang() === 'pt' ? 'pt-BR' : 'en'}"><head><meta charset="utf-8"><title>kScreen</title>
<style>${font ? `@font-face{font-family:'K2D';src:url(${font}) format('truetype');font-weight:700;font-display:block}` : ''}
html,body{height:100%;margin:0}body{background:#0b0c0e;color:#f2f2f5;font:15px/1.5 'Inter','Segoe UI',system-ui,sans-serif;display:grid;place-items:center;text-align:center;padding:24px;box-sizing:border-box}
.logo{font-family:'K2D',sans-serif;font-size:58px;font-weight:700;line-height:1;letter-spacing:-1.5px;margin:0 0 28px}.logo .k{color:#F53F5F}.logo .s{color:#fff}
h1{font-size:19px;font-weight:600;margin:0 0 6px}p{color:#9a9ba5;margin:0}</style></head>
<body><div><div class="logo"><span class="k">k</span><span class="s">Screen</span></div><h1>${tr(message)}</h1>
<p>${tr(ok ? 'Pode fechar esta aba e voltar ao app.' : 'Volte ao app e tente entrar de novo.')}</p></div></body></html>`;
}

function showLoginWait(error) {
  if (!mainWindow) return;
  siteContents()?.loadFile(path.join(__dirname, 'login-wait.html'), { query: error ? { error } : {} });
}

function startBrowserLogin(siteLoginUrl) {
  let returnTo = '/';
  try {
    returnTo = new URL(siteLoginUrl).searchParams.get('returnTo') || '/';
  } catch { /* default */ }
  cancelLogin();

  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== '/kscreen-auth' || !login || login.server !== server) {
      res.writeHead(404).end();
      return;
    }
    const code = url.searchParams.get('code');
    const ok = !!code && /^[A-Za-z0-9_-]{20,100}$/.test(code);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(loginDonePage(ok, ok ? 'Login concluído!' : 'O login não foi concluído.'));
    const { verifier: v, returnTo: back } = login;
    cancelLogin();
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.flashFrame(true);
    setTimeout(() => mainWindow?.flashFrame(false), 3000);
    if (!ok) {
      showLoginWait(url.searchParams.get('error') || 'denied');
      return;
    }
    // Redeem inside the app window, so the session cookie lands here (POST: code/verifier never sit in a URL).
    const body = new URLSearchParams({ code, verifier: v, returnTo: back }).toString();
    siteContents()?.loadURL(`${SERVER}/api/auth/desktop/redeem`, {
      postData: [{ type: 'rawData', bytes: Buffer.from(body) }],
      extraHeaders: 'Content-Type: application/x-www-form-urlencoded'
    });
  });

  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    const authUrl = new URL('/api/auth/discord/login', SERVER);
    authUrl.searchParams.set('returnTo', returnTo);
    authUrl.searchParams.set('desktop', String(port));
    authUrl.searchParams.set('challenge', challenge);
    login = {
      server, verifier, returnTo,
      authUrl: authUrl.href,
      timer: setTimeout(() => { cancelLogin(); showLoginWait('timeout'); }, LOGIN_TIMEOUT_MS)
    };
    shell.openExternal(login.authUrl);
    showLoginWait();
  });
  server.on('error', () => showLoginWait('server'));
}

function fromLoginWait(event) {
  return mainWindow && event.sender === siteContents() && event.sender.getURL().includes('login-wait.html');
}

ipcMain.on('login:reopen', (event) => {
  if (!fromLoginWait(event)) return;
  if (login) shell.openExternal(login.authUrl);
  else startBrowserLogin(`${SERVER}/api/auth/discord/login`);
});

ipcMain.on('login:cancel', (event) => {
  if (!fromLoginWait(event)) return;
  cancelLogin();
  siteContents()?.loadURL(startUrl());
});

app.on('will-quit', cancelLogin);

// ---------------------------------------------------------------------------
// Title bar (titlebar.html in the frameless window)
// ---------------------------------------------------------------------------

const fromTitlebar = (event) => mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;
ipcMain.on('titlebar:ready', (event) => { if (fromTitlebar(event)) sendTitlebarState(); });
ipcMain.on('titlebar:minimize', (event) => { if (fromTitlebar(event)) mainWindow.minimize(); });
ipcMain.on('titlebar:maximize', (event) => {
  if (!fromTitlebar(event)) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('titlebar:close', (event) => { if (fromTitlebar(event)) mainWindow.close(); });

// The site reports the room it is in (code + whether it has a password) for the title bar.
ipcMain.on('app:room-state', (event, state) => {
  if (event.sender !== siteContents()) return;
  const room = typeof state?.room === 'string' && /^[a-z0-9_-]{1,40}$/i.test(state.room) ? state.room : null;
  roomState = { room, locked: !!(room && state.locked) };
  sendTitlebarState();
});

// ---------------------------------------------------------------------------
// Bridge for the site (see preload.js)
// ---------------------------------------------------------------------------

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  server: SERVER
}));

ipcMain.on('app:open-external', (event, url) => {
  if (BrowserWindow.fromWebContents(event.sender)) openExternal(url);
});

ipcMain.on('app:set-server', (event, url) => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && !isLoopback(parsed.hostname)) return;
    saveSettings({ server: parsed.origin });
    app.relaunch();
    app.exit(0);
  } catch { /* invalid */ }
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Hybrid-GPU laptops (Windows)
// ---------------------------------------------------------------------------

// Laptops with two GPUs show everything through the integrated one (Intel UHD / AMD iGPU); the
// dedicated GPU (e.g. an RTX 3050) renders the game and hands its frames over. Windows can only
// duplicate a display from the GPU it is attached to (Microsoft: "Desktop Duplication fails
// with DXGI_ERROR_UNSUPPORTED when run against the discrete GPU on a hybrid system"), so kScreen
// must run on the integrated GPU there - like OBS's display capture on laptops. The game keeps
// its dedicated GPU; kScreen's capture and video encoding then also stay off it.
//
// When the laptop's own screen is the main one, kScreen sets itself to "power saving" in
// Windows' per-app graphics setting (relaunching once so it applies). If that stops being true
// (external monitor as the main screen, dGPU-only mode), the previous setting is put back.
// Returns true when the setting changed and the app should start again.
async function tuneHybridGpu() {
  if (!platform.gpu) return false;
  // In development the exe is electron.exe, shared by every Electron app: leave it alone.
  if (!app.isPackaged && process.env.KSCREEN_GPU_TEST !== '1') return false;
  const exe = process.execPath;
  const settings = loadSettings();
  let devices = [];
  try { devices = (await app.getGPUInfo('basic'))?.gpuDevice || []; } catch { /* no GPU info */ }
  // Chromium tags the GPU Windows picks for "power saving" (1) and "high performance" (2).
  const low = devices.find(g => g.gpuPreference === 1);
  const high = devices.find(g => g.gpuPreference === 2);
  const hybrid = !!(low && high && (low.vendorId !== high.vendorId || low.deviceId !== high.deviceId));
  const laptopScreenIsMain = !!screen.getPrimaryDisplay()?.internal;
  const current = await platform.gpu.get(exe);

  if (hybrid && laptopScreenIsMain) {
    if (current === 1) return false;
    // Remember what was there (a manual "high performance", or nothing) to restore it later.
    if (!settings.gpuPrefManaged) saveSettings({ gpuPrefPrevious: current });
    if (!(await platform.gpu.set(exe, 1)) || (await platform.gpu.get(exe)) !== 1) return false;
    // Never loop: at most one relaunch per minute.
    if (settings.gpuRelaunchAt && Date.now() - settings.gpuRelaunchAt < 60_000) {
      saveSettings({ gpuPrefManaged: true });
      return false;
    }
    saveSettings({ gpuPrefManaged: true, gpuRelaunchAt: Date.now() });
    console.log(`[gpu] notebook híbrido (${low.deviceString} + ${high.deviceString}): kScreen na GPU integrada`);
    return true;
  }

  // Not (or no longer) a laptop showing on its own screen: undo our change.
  if (settings.gpuPrefManaged) {
    const previous = settings.gpuPrefPrevious;
    if (current === 1) {
      if (previous === 2 || previous === 0) await platform.gpu.set(exe, previous);
      else await platform.gpu.clear(exe);
    }
    saveSettings({ gpuPrefManaged: false, gpuPrefPrevious: null });
  }
  return false;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const room = roomFromDeepLink(argv.find(a => a.startsWith(`${PROTOCOL}://`)));
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    if (room) openRoom(room);
  });

  // Only the installed app owns kscreen:// links (a dev run must not hijack them).
  if (app.isPackaged) app.setAsDefaultProtocolClient(PROTOCOL);

  app.whenReady().then(async () => {
    if (await tuneHybridGpu()) {
      // The GPU choice only applies to new processes: start again once, before any window.
      app.relaunch({ args: process.argv.slice(1) });
      app.exit(0);
      return;
    }
    nativeTheme.themeSource = 'dark';
    Menu.setApplicationMenu(null);
    if (process.platform === 'win32') app.setAppUserModelId('br.com.kennyy.kscreen');
    configureSession(session.defaultSession);
    createMainWindow();
    app.on('activate', () => {
      if (!BrowserWindow.getAllWindows().length) createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
