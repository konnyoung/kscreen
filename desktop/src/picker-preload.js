'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('picker', {
  init: () => ipcRenderer.invoke('picker:init'),
  sources: () => ipcRenderer.invoke('picker:sources'),
  apps: () => ipcRenderer.invoke('picker:apps'),
  choose: (c) => ipcRenderer.send('picker:choose', {
    id: String(c?.id), audio: !!c?.audio, resolution: String(c?.resolution || ''), fps: Number(c?.fps) || 0,
    audioQuality: String(c?.audioQuality || ''),
    audioExclude: Array.isArray(c?.audioExclude) ? c.audioExclude.map(String) : undefined
  }),
  cancel: () => ipcRenderer.send('picker:cancel')
});
