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
