'use strict';
// Bridge between the kScreen site and the desktop app. The site checks `window.kscreenDesktop`
// to adapt (native picker, echo-free system audio). Nothing else is exposed to the page.
const { contextBridge, ipcRenderer } = require('electron');

let onData = null;
let onEnded = null;
ipcRenderer.on('system-audio:data', (_event, chunk) => onData?.(chunk));
ipcRenderer.on('system-audio:ended', () => onEnded?.());
let onPaused = null;
ipcRenderer.on('share:paused', (_event, paused) => onPaused?.(!!paused));
let onReplayHotkey = null;
ipcRenderer.on('replay:hotkey', () => onReplayHotkey?.());
let onPcData = null;
let onPcEnded = null;
ipcRenderer.on('replay:pc-audio-data', (_event, chunk) => onPcData?.(chunk));
ipcRenderer.on('replay:pc-audio-ended', () => onPcEnded?.());

contextBridge.exposeInMainWorld('kscreenDesktop', {
  isDesktop: true,
  platform: process.platform,
  // The capture picker is native; "share PC audio" is a toggle in it (Windows).
  nativeCapture: true,
  info: () => ipcRenderer.invoke('app:info'),
  openExternal: (url) => ipcRenderer.send('app:open-external', String(url)),
  // Room shown in the app's title bar.
  roomState: (state) => ipcRenderer.send('app:room-state', { room: state?.room ? String(state.room) : null, locked: !!state?.locked }),
  // Used by the "continue in your browser" screen while logging in.
  login: {
    reopen: () => ipcRenderer.send('login:reopen'),
    cancel: () => ipcRenderer.send('login:cancel')
  },
  // Quality picked in the app's own picker (resolution/FPS), handed back to the site.
  share: {
    prepare: (settings) => ipcRenderer.send('share:prepare', { resolution: String(settings?.resolution || ''), fps: Number(settings?.fps) || 0, audioQuality: String(settings?.audioQuality || '') }),
    result: () => ipcRenderer.invoke('share:result'),
    // Fullscreen game captured through its monitor: true while the game is not in front.
    onPaused: (handler) => { onPaused = typeof handler === 'function' ? handler : null; },
    ended: () => ipcRenderer.send('share:ended')
  },
  // Instant Replay (desktop only). The site checks `api` and then capabilities(), which resolves
  // to { api, features: [...] }; only listed features may be used ('replay').
  replay: {
    api: 1,
    capabilities: () => ipcRenderer.invoke('replay:capabilities'),
    getSettings: () => ipcRenderer.invoke('replay:get-settings'),
    setSettings: (patch) => ipcRenderer.invoke('replay:set-settings', {
      ...(patch && 'enabled' in patch ? { enabled: !!patch.enabled } : {}),
      ...(patch && 'seconds' in patch ? { seconds: Number(patch.seconds) } : {}),
      ...(patch && 'hotkey' in patch ? { hotkey: String(patch.hotkey) } : {}),
      ...(patch && 'mic' in patch ? { mic: !!patch.mic } : {}),
      ...(patch && 'micAlways' in patch ? { micAlways: !!patch.micAlways } : {}),
      ...(patch && 'pcAudio' in patch ? { pcAudio: !!patch.pcAudio } : {}),
      ...(patch && 'voices' in patch ? { voices: !!patch.voices } : {}),
      ...(patch && 'micMode' in patch ? { micMode: String(patch.micMode) } : {})
    }),
    // The PC's sound for the replay alone (share without audio), PCM like systemAudio below.
    pcAudio: {
      start: async (handlers) => {
        const format = await ipcRenderer.invoke('replay:pc-audio-start');
        if (!format) return null;
        onPcData = typeof handlers?.data === 'function' ? handlers.data : null;
        onPcEnded = typeof handlers?.ended === 'function' ? handlers.ended : null;
        return format;
      },
      stop: () => {
        onPcData = null;
        onPcEnded = null;
        ipcRenderer.send('replay:pc-audio-stop');
      }
    },
    // Notes for the app's log (start, save, errors), so problems can be read without DevTools.
    diag: (event, data) => ipcRenderer.send('replay:diag', String(event).slice(0, 40), data),
    // The buffer is running (registers the global shortcut) or stopped (frees it).
    setActive: (on) => ipcRenderer.invoke('replay:set-active', !!on),
    onHotkey: (handler) => { onReplayHotkey = typeof handler === 'function' ? handler : null; },
    // A clip is written in pieces: begin({ size, opus }) -> { id } | { error }, write(id, Uint8Array),
    // end(id) -> { path, name, audio? } | { error }; abort(id) deletes the unfinished file.
    // opus: the clip has Opus audio (Linux), which the app re-encodes to AAC when it can.
    clip: {
      begin: (info) => ipcRenderer.invoke('replay:clip-begin', { size: Number(info?.size) || 0, opus: !!info?.opus }),
      write: (id, bytes) => ipcRenderer.invoke('replay:clip-write', Number(id), bytes),
      end: (id) => ipcRenderer.invoke('replay:clip-end', Number(id)),
      abort: (id) => ipcRenderer.invoke('replay:clip-abort', Number(id))
    },
    openFolder: () => ipcRenderer.invoke('replay:open-folder'),
    showClip: (file) => ipcRenderer.send('replay:show-clip', String(file))
  },
  systemAudio: {
    // Call right after getDisplayMedia. Resolves to { sampleRate, channels, format: 's16' } when
    // the user picked "share PC audio", else null. PCM (Uint8Array, interleaved s16le) then
    // arrives through handlers.data until stop() or handlers.ended.
    start: async (handlers) => {
      const format = await ipcRenderer.invoke('system-audio:start');
      if (!format) return null;
      onData = typeof handlers?.data === 'function' ? handlers.data : null;
      onEnded = typeof handlers?.ended === 'function' ? handlers.ended : null;
      return format;
    },
    stop: () => {
      onData = null;
      onEnded = null;
      ipcRenderer.send('system-audio:stop');
    }
  }
});
