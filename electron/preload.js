'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Expose server port and Electron-specific APIs to the renderer.
// main.js sets ELECTRON_SERVER_PORT just before creating the window.
contextBridge.exposeInMainWorld('electronAPI', {
  serverPort: process.env.ELECTRON_SERVER_POR