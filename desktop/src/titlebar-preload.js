'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('titlebar', {
  minimize: () => ipcRenderer.send('titlebar:minimize'),
  toggleMaximize: () => ipcRenderer.send('titlebar:maximize'),
  close: () => ipcRenderer.send('titlebar:close'),
  onState: (cb) => {
    ipcRenderer.on('titlebar:state', (_event, state) => cb(state));
    ipcRenderer.send('titlebar:ready');
  }
});
