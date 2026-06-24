'use strict';
const { contextBridge } = require('electron');

// Expose server port to the renderer before page scripts run.
// main.js sets ELECTRON_SERVER_PORT just before creating the window.
contextBridge.exposeInMainWorld('electronAPI', {
  serverPort: process.env.ELECTRON_SERVER_PORT || '3000'
});
