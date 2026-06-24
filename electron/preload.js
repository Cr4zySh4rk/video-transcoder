'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Expose server port and Electron-specific APIs to the renderer.
// main.js sets ELECTRON_SERVER_PORT just before creating the window.
contextBridge.exposeInMainWorld('electronAPI', {
  isElectron:  true,
  serverPort:  parseInt(process.env.ELECTRON_SERVER_PORT || '3000', 10),
  pickFolder:  () => ipcRenderer.invoke('pick-folder'),
  openPath:    (p) => ipcRenderer.invoke('open-path', p),
  getServerPort: () => ipcRenderer.invoke('get-server-port'),
});
