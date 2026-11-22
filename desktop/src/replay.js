'use strict';
/**
 * Instant Replay (desktop only): the app side of the "replay" capability.
 *
 * The site (src/replay.js) keeps the last seconds of the user's own share encoded in memory and,
 * on "save", sends the finished MP4 here in pieces. This side owns what a web page must not:
 *  - the settings (userData/replay.json, written asynchronously);
 *  - the global shortcut, registered only while the replay buffer is running;
 *  - the clip files: written to <Videos>/kScreen as .part and renamed when complete, so a failed
 *    or interrupted save never leaves a broken .mp4 behind.
 *
 * The site only offers the feature when capabilities() lists 'replay' (the web version has no
 * bridge at all).
 */
const { app, ipcMain, globalShortcut, shell } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

// Version of the bridge contract (preload.js `replay.api`, checked by the site).
const REPLAY_API = 1;
const DURATIONS = [15, 30, 60, 120];
// Offered shortcuts (registered only while the replay runs, so they don't steal keys otherwise).
// A registered key never reaches the game, so the default has a modifier (Alt+F10, as in other
// clip tools); bare F-keys are there for whoever wants them.
const HOTKEYS = ['Alt+F10', 'Alt+F9', 'Alt+F8', 'Ctrl+Shift+F10', 'F8', 'F9', 'F10', 'Ctrl+Shift+S'];
// micMode 'mixed' by default: one audio track plays in any player or chat (separate tracks are
// for editors).
const DEFAULTS = { enabled: false, seconds: 30, hotkey: 'Alt+F10', mic: true, micAlways: false, pcAudio: false, voices: false, micMode: 'mixed' };
// The clip's audio: one track per source, or all mixed into the first one.
const MIC_MODES = ['separate', 'mixed'];
// Kept free on the disk after a clip, so a save never fills it up.
const DISK_MARGIN = 500 * 1024 * 1024;
const MAX_CLIP_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_WRITE_BYTES = 16 * 1024 * 1024;

module.exports = function initReplay({ isAppUrl, platform, audioExclude = () => [], portalShortcuts = null }) {
  const settingsFile = path.join(app.getPath('userData'), 'replay.json');
  const clipsDir = () => path.join(app.getPath('videos'), 'kScreen');
  let settings = { ...DEFAULTS };
  const loaded = fsp.readFile(settingsFile, 'utf8')
    .then((text) => { settings = clean({ ...DEFAULTS, ...JSON.parse(text) }); })
    .catch(() => { /* first run or unreadable: defaults */ });

  // Leftovers of saves cut short by a crash or a forced quit. Only in the instance that owns the
  // app: a second launch (`kscreen --save-clip`, a kscreen:// link) loads this file too, and must
  // not delete the .part of a clip the running instance is writing at that very moment.
  app.whenReady()
    .then(() => {
      if (!app.hasSingleInstanceLock()) return null;
      return fsp.readdir(clipsDir())
        .then(names => Promise.all(names.filter(n => n.endsWith('.mp4.part')).map(n => fsp.unlink(path.join(clipsDir(), n)).catch(() => {}))));
    })
    .catch(() => { /* no folder yet */ });

  function clean(value) {
    const v = value || {};
    return {
      enabled: !!v.enabled,
      seconds: DURATIONS.includes(Number(v.seconds)) ? Number(v.seconds) : DEFAULTS.seconds,
      hotkey: HOTKEYS.includes(v.hotkey) ? v.hotkey : DEFAULTS.hotkey,
      // The mic as its own track in the clip (the voice as the room hears it).
      mic: v.mic === undefined ? DEFAULTS.mic : !!v.mic,
      // Record the mic even while muted in the room (local only: the room still hears nothing).
      micAlways: !!v.micAlways,
      // Record the PC's sound even when the share has none or has it muted.
      pcAudio: !!v.pcAudio,
      // The room's voices, as you hear them (local only, like the rest of the clip).
      voices: !!v.voices,
      micMode: MIC_MODES.includes(v.micMode) ? v.micMode : DEFAULTS.micMode
    };
  }

  // Writes queue up (never two at once) and go through a temp file + rename.
  let writing = Promise.resolve();
  function persist() {
    const text = JSON.stringify(settings, null, 2);
    writing = writing.then(async () => {
      try {
        await fsp.mkdir(path.dirname(settingsFile), { recursive: true });
        await fsp.writeFile(`${settingsFile}.tmp`, text);
        await fsp.rename(`${settingsFile}.tmp`, settingsFile);
      } catch (err) { console.warn('[replay] configurações não salvas:', err.message); }
    });
    return writing;
  }

  const fromApp = (event) => isAppUrl(event.sender.getURL());

  // Linux extras (platform/linux.js): AAC through the host's ffmpeg, the shortcut command and
  // what to install for GPU encoding.
  const linuxClips = platform.clips || null;
  async function gpuVendor() {
    try {
      const info = await app.getGPUInfo('basic');
      const devices = info?.gpuDevice || [];
      return (devices.find(d => d.active) || devices[0])?.vendorId || 0;
    } catch {
      return 0;
    }
  }

  ipcMain.handle('replay:capabilities', async (event) => {
    if (!fromApp(event)) return null;
    const aac = !linuxClips ? 'native' : (await linuxClips.hasAacEncoder().catch(() => false)) ? 'ffmpeg' : 'none';
    return {
      api: REPLAY_API,
      features: ['replay'],
      platform: process.platform,
      durations: DURATIONS,
      hotkeys: HOTKEYS,
      pcAudio: await pcAudioSupported(),
      // Wayland: apps can't grab keys by themselves; the shortcut goes through the desktop's
      // portal (when it has one) or a system shortcut running `kscreen --save-clip`.
      wayland: isWayland(),
      // How the shortcut is registered: 'portal' (Wayland: the system owns the key) or
      // 'electron'. On Hyprland the key is bound in hyprland.conf with `bindLine`.
      shortcut: shortcutInfo(),
      // 'native' (Windows: the encoder has AAC), 'ffmpeg' (Linux: Opus re-encoded to AAC after
      // saving) or 'none' (Linux without ffmpeg: clips keep Opus audio).
      aac,
      saveClipCommand: linuxClips?.saveClipCommand || 'kscreen --save-clip',
      // Linux: what to install to encode on the GPU, for this distro and GPU (settings page).
      gpuGuide: linuxClips ? await linuxClips.gpuGuide(await gpuVendor()).catch(() => null) : null
    };
  });

  ipcMain.handle('replay:get-settings', async (event) => {
    if (!fromApp(event)) return null;
    await loaded;
    return { ...settings, folder: clipsDir(), excludedApps: audioExclude().length };
  });

  ipcMain.handle('replay:set-settings', async (event, patch) => {
    if (!fromApp(event)) return null;
    await loaded;
    const before = settings;
    settings = clean({ ...settings, ...(patch && typeof patch === 'object' ? patch : {}) });
    persist();
    // A new shortcut while the replay runs takes effect right away (on Wayland the system owns
    // the key: nothing to do).
    if (active && settings.hotkey !== before.hotkey && !portal) await registerHotkey();
    return { ...settings, folder: clipsDir(), excludedApps: audioExclude().length, hotkeyRegistered: active ? !!active.registered : null };
  });

  // Also kept in <userData>/replay-log.txt (one line per event, ~1 MB then rotated), so a
  // problem can be looked at after the fact however the app was started.
  const logFile = path.join(app.getPath('userData'), 'replay-log.txt');
  let logging = Promise.resolve();
  ipcMain.on('replay:diag', (event, name, data) => {
    if (!fromApp(event)) return;
    let text = '';
    try { text = JSON.stringify(data).slice(0, 4000); } catch { /* not serializable */ }
    const line = `${new Date().toISOString()} ${String(name).slice(0, 40)} ${text}
`;
    console.log(`[replay] ${line.trim()}`);
    logging = logging.then(async () => {
      try {
        const stat = await fsp.stat(logFile).catch(() => null);
        if (stat && stat.size > 1024 * 1024) await fsp.rename(logFile, `${logFile}.old`).catch(() => {});
        await fsp.appendFile(logFile, line);
      } catch { /* log is best effort */ }
    });
  });

  // ---- the PC's sound for the replay alone (when the share has none) ------------------------
  // The same echo-free capture as the share's: without kScreen (so no room voices), but WITH the
  // apps left out of the share ("all PC sound" means them too). Windows: a second helper
  // process; Linux: a second PipeWire sink of its own (see platform/linux.js).
  const pcCaptures = new Map(); // webContents id -> handle
  const pcWatched = new WeakSet();

  async function pcAudioSupported() {
    return !!(await platform.audio?.supported?.().catch(() => false));
  }

  function stopPcAudio(id) {
    const handle = pcCaptures.get(id);
    if (!handle) return;
    pcCaptures.delete(id);
    handle.stop();
  }

  ipcMain.handle('replay:pc-audio-start', async (event) => {
    if (!fromApp(event) || !(await pcAudioSupported())) return null;
    const sender = event.sender;
    const id = sender.id;
    stopPcAudio(id);
    const handle = platform.audio.start({ selfPid: process.pid, exclude: [] });
    if (!handle) return null;
    pcCaptures.set(id, handle);
    // ~20 ms of PCM per message, like the share's capture.
    let pending = [];
    let pendingBytes = 0;
    handle.stdout.on('data', (chunk) => {
      pending.push(chunk);
      pendingBytes += chunk.length;
      if (pendingBytes < 3840) return;
      const data = Buffer.concat(pending, pendingBytes);
      pending = [];
      pendingBytes = 0;
      if (!sender.isDestroyed()) sender.send('replay:pc-audio-data', data);
    });
    handle.onExit(() => {
      if (pcCaptures.get(id) !== handle) return;
      pcCaptures.delete(id);
      if (!sender.isDestroyed()) sender.send('replay:pc-audio-ended');
    });
    if (!pcWatched.has(sender)) {
      pcWatched.add(sender);
      sender.once('destroyed', () => stopPcAudio(id));
      sender.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) stopPcAudio(id);
      });
    }
    return { sampleRate: 48000, channels: 2, format: 's16' };
  });

  ipcMain.on('replay:pc-audio-stop', (event) => stopPcAudio(event.sender.id));

  // ---- global shortcut: only while a page has the replay buffer running ----------------------

  let active = null; // { sender, accelerator, registered }
  const watchedPages = new WeakSet();

  // Wayland: Electron's globalShortcut says yes but never gets the key, so the shortcut goes
  // through the desktop portal (portal-shortcuts.js). Bound once per run; a press while no
  // replay runs is ignored.
  const APP_ID = process.env.FLATPAK_ID || 'br.com.kennyy.kscreen';
  const SHORTCUT_ID = 'save-clip';
  const portal = isWayland()
    ? (portalShortcuts || require('./portal-shortcuts').createPortalShortcuts({ appId: APP_ID }))
    : null;
  let portalBound = null; // Promise<{ ok, trigger, error }>

  function shortcutInfo() {
    if (!portal) return { via: 'electron' };
    const desktop = String(process.env.XDG_CURRENT_DESKTOP || '').split(':')[0];
    const keys = settings.hotkey.split('+');
    const key = keys.pop();
    const mods = keys.map(k => ({ ctrl: 'CTRL', alt: 'ALT', shift: 'SHIFT', super: 'SUPER' }[k.toLowerCase()] || k.toUpperCase()));
    const id = `${APP_ID}:${SHORTCUT_ID}`;
    // Hyprland 0.55+ can be configured in Lua (hyprland.lua) instead of hyprland.conf.
    const lua = desktop === 'Hyprland' && hyprlandUsesLua();
    const bindLine = desktop !== 'Hyprland' ? null
      : lua ? `hl.bind("${[...mods, key].join(' + ')}", hl.dsp.global("${id}"))`
        : `bind = ${mods.join(' ')}, ${key}, global, ${id}`;
    return { via: 'portal', desktop, id, ...(bindLine ? { bindLine, configFile: lua ? 'hyprland.lua' : 'hyprland.conf' } : {}) };
  }

  function unregisterHotkey() {
    if (active?.registered && !portal) {
      try { globalShortcut.unregister(active.accelerator); } catch { /* already gone */ }
    }
    if (active) active.registered = false;
  }

  async function registerHotkey() {
    if (!active) return false;
    unregisterHotkey();
    const current = active;
    current.accelerator = settings.hotkey;
    if (portal) {
      portalBound ??= portal.bind({
        id: SHORTCUT_ID,
        description: 'Salvar clipe (Instant Replay)',
        accelerator: settings.hotkey,
        onActivated: () => {
          if (active && !active.sender.isDestroyed()) active.sender.send('replay:hotkey');
        }
      }).then((res) => {
        if (!res.ok) { console.warn('[replay] portal de atalhos:', res.error); portalBound = null; }
        return res;
      });
      const res = await portalBound;
      current.registered = res.ok;
      current.trigger = res.trigger || '';
      return current.registered;
    }
    const sender = current.sender;
    try {
      current.registered = globalShortcut.register(settings.hotkey, () => {
        if (!sender.isDestroyed()) sender.send('replay:hotkey');
      });
    } catch {
      current.registered = false;
    }
    return current.registered;
  }

  function deactivate(sender) {
    if (!active || (sender && active.sender !== sender)) return;
    unregisterHotkey();
    active = null;
  }

  ipcMain.handle('replay:set-active', async (event, on) => {
    if (!fromApp(event)) return null;
    await loaded;
    const sender = event.sender;
    if (!on) {
      deactivate(sender);
      return { registered: false };
    }
    // One owner at a time; a restart from the same page frees its old key first.
    deactivate();
    active = { sender, accelerator: settings.hotkey, registered: false };
    if (!watchedPages.has(sender)) {
      watchedPages.add(sender);
      // A reload or a closed window ends the replay: free the key and any half-written clip.
      sender.once('destroyed', () => { deactivate(sender); abortClipsOf(sender); });
      sender.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) { deactivate(sender); abortClipsOf(sender); }
      });
    }
    const registered = await registerHotkey();
    return { registered, hotkey: settings.hotkey, trigger: active?.trigger || '' };
  });

  // ---- clip files ----------------------------------------------------------------------------

  const clips = new Map(); // id -> { sender, handle, part, final, written, size }
  let clipSeq = 0;

  function clipName(date = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `kScreen ${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
  }

  async function abortClip(id) {
    const clip = clips.get(id);
    if (!clip) return;
    clips.delete(id);
    await clip.handle.close().catch(() => {});
    await fsp.unlink(clip.part).catch(() => {});
  }

  function abortClipsOf(sender) {
    for (const [id, clip] of clips) if (clip.sender === sender) abortClip(id);
  }

  ipcMain.handle('replay:clip-begin', async (event, info) => {
    if (!fromApp(event)) return { error: 'denied' };
    const size = Number(info?.size) || 0;
    // Opus audio on Linux: re-encoded to AAC by ffmpeg once the file is complete.
    const toAac = !!info?.opus && !!linuxClips && await linuxClips.hasAacEncoder().catch(() => false);
    if (size <= 0 || size > MAX_CLIP_BYTES) return { error: 'size' };
    if (clips.size >= 2) return { error: 'busy' };
    const dir = clipsDir();
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch {
      return { error: 'folder' };
    }
    try {
      const stat = await fsp.statfs(dir);
      if (stat.bavail * stat.bsize < size + DISK_MARGIN) return { error: 'disk-full' };
    } catch { /* statfs unavailable: the write itself will fail if the disk fills */ }
    let base = clipName();
    let final = path.join(dir, `${base}.mp4`);
    for (let n = 2; fs.existsSync(final); n++) final = path.join(dir, `${base} (${n}).mp4`);
    const part = `${final}.part`;
    let handle;
    try {
      handle = await fsp.open(part, 'wx');
    } catch (err) {
      console.warn('[replay] clipe não criado:', err.message);
      return { error: 'folder' };
    }
    const id = ++clipSeq;
    clips.set(id, { sender: event.sender, handle, part, final, written: 0, size, toAac });
    return { id };
  });

  ipcMain.handle('replay:clip-write', async (event, id, bytes) => {
    const clip = clips.get(id);
    if (!clip || clip.sender !== event.sender) return { error: 'unknown' };
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_WRITE_BYTES || clip.written + bytes.byteLength > clip.size) {
      console.warn('[replay] pedaço do clipe recusado:', bytes?.constructor?.name, bytes?.byteLength, clip.written, clip.size);
      await abortClip(id);
      return { error: 'size' };
    }
    try {
      await clip.handle.write(bytes);
      clip.written += bytes.byteLength;
      return { ok: true };
    } catch (err) {
      console.warn('[replay] erro ao gravar o clipe:', err.message);
      await abortClip(id);
      return { error: err.code === 'ENOSPC' ? 'disk-full' : 'write' };
    }
  });

  ipcMain.handle('replay:clip-end', async (event, id) => {
    const clip = clips.get(id);
    if (!clip || clip.sender !== event.sender) return { error: 'unknown' };
    if (clip.written !== clip.size) {
      await abortClip(id);
      return { error: 'incomplete' };
    }
    clips.delete(id);
    try {
      await clip.handle.close();
      let audio = clip.toAac ? 'opus' : null;
      if (clip.toAac) {
        // Written next to it as another .part (cleaned up like the others after a crash). If
        // ffmpeg fails, the Opus clip is kept: a clip with less compatible audio beats none.
        const converted = `${clip.final}.aac.mp4.part`;
        if (await linuxClips.toAac(clip.part, converted)) {
          await fsp.rename(converted, clip.final);
          await fsp.unlink(clip.part).catch(() => {});
          audio = 'aac';
        } else {
          await fsp.unlink(converted).catch(() => {});
        }
      }
      if (audio !== 'aac') await fsp.rename(clip.part, clip.final);
      return { path: clip.final, name: path.basename(clip.final), ...(audio ? { audio } : {}) };
    } catch (err) {
      console.warn('[replay] erro ao finalizar o clipe:', err.message);
      await fsp.unlink(clip.part).catch(() => {});
      return { error: 'write' };
    }
  });

  ipcMain.handle('replay:clip-abort', async (event, id) => {
    const clip = clips.get(id);
    if (clip && clip.sender === event.sender) await abortClip(id);
  });

  ipcMain.handle('replay:open-folder', async (event) => {
    if (!fromApp(event)) return false;
    try {
      await fsp.mkdir(clipsDir(), { recursive: true });
      return (await shell.openPath(clipsDir())) === '';
    } catch {
      return false;
    }
  });

  // Shows a saved clip in Explorer (only files inside the clips folder).
  ipcMain.on('replay:show-clip', (event, file) => {
    if (!fromApp(event) || typeof file !== 'string') return;
    const resolved = path.resolve(file);
    if (path.dirname(resolved) === path.resolve(clipsDir()) && resolved.endsWith('.mp4')) shell.showItemInFolder(resolved);
  });

  app.on('will-quit', () => {
    deactivate();
    portal?.close();
    for (const id of [...pcCaptures.keys()]) stopPcAudio(id);
    for (const id of [...clips.keys()]) abortClip(id);
  });

  return {
    // `kscreen --save-clip` (a second launch, see main.js): same as the shortcut. Returns false
    // when no replay is running.
    saveClip() {
      if (!active || active.sender.isDestroyed()) return false;
      active.sender.send('replay:hotkey');
      return true;
    }
  };
};

function hyprlandUsesLua() {
  const base = process.env.XDG_CONFIG_HOME || path.join(require('node:os').homedir(), '.config');
  return fs.existsSync(path.join(base, 'hypr', 'hyprland.lua')) && !fs.existsSync(path.join(base, 'hypr', 'hyprland.conf'));
}

const isWayland = () => process.platform === 'linux' && (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY);
