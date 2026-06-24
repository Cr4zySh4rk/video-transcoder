'use strict';

const { app, BrowserWindow, shell, ipcMain, dialog, Menu, Tray, nativeImage } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

// ── Resolve paths inside asar or dev ──────────────────────────────────────
const isPackaged = app.isPackaged;

// server.js, docs/, ffmpeg-static and ffprobe-static are all in asarUnpack,
// so they live at app.asar.unpacked/ inside the package — real files the OS can execute.
// In dev they're just at the repo root.
const rootDir = isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked')
  : path.join(__dirname, '..');

// ffmpeg-static returns a path inside the virtual asar (e.g. /…/app.asar/node_modules/…).
// We need the real on-disk path in app.asar.unpacked so the OS can actually execute it.
function toUnpacked(p) {
  return p.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1');
}

// ── Override ffmpeg/ffprobe paths to use bundled binaries ─────────────────
try {
  const ffmpegRaw   = require('ffmpeg-static');
  const ffprobeRaw  = require('ffprobe-static').path;
  process.env.FFMPEG_PATH  = isPackaged ? toUnpacked(ffmpegRaw)  : ffmpegRaw;
  process.env.FFPROBE_PATH = isPackaged ? toUnpacked(ffprobeRaw) : ffprobeRaw;
  const ffDir = path.dirname(process.env.FFMPEG_PATH);
  process.env.PATH = ffDir + path.delimiter + (process.env.PATH || '');
  console.log('[main] ffmpeg:', process.env.FFMPEG_PATH);
  console.log('[main] ffprobe:', process.env.FFPROBE_PATH);
} catch (e) {
  console.warn('ffmpeg-static not found, falling back to system FFmpeg:', e.message);
}

const PREFERRED_PORT = 3000;
let   actualPort       = PREFERRED_PORT;
let serverProcess = null;  // kept for legacy cleanup
let serverModule   = null;  // inline-required server
let mainWindow    = null;
let tray          = null;

// ── Single-instance lock ───────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// ── Start embedded Node.js server ─────────────────────────────────────────
// We require() server.js directly in the main process rather than spawning it.
// Spawning process.execPath (the Electron binary) doesn't work in packaged
// apps — it just opens a second app instance instead of running Node.js.
// require() works from the asar via Electron's patched module system.
function startServer() {
  return new Promise((resolve, reject) => {
    // Set env vars that server.js reads at module-load time
    process.env.PORT        = String(PREFERRED_PORT);
    process.env.ELECTRON_RUN = '1';
    process.env.UPLOADS_DIR = path.join(app.getPath('userData'), 'uploads');
    process.env.OUTPUTS_DIR = path.join(app.getPath('userData'), 'outputs');
    // docs/ is unpacked to asar.unpacked; tell server.js where to find them
    process.env.DOCS_DIR    = isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'docs')
      : path.join(__dirname, '..', 'docs');

    try {
      const serverPath = isPackaged
        ? path.join(process.resourcesPath, 'app.asar', 'server.js')
        : path.join(__dirname, '..', 'server.js');
      serverModule = require(serverPath);
      console.log('[main] server module loaded from', serverPath);
    } catch (e) {
      return reject(new Error('Failed to load server: ' + e.message));
    }

    // server.js exports portReady — resolves with the port it actually bound to
    // (auto-increments from PREFERRED_PORT if 3000 is taken)
    const timer = setTimeout(() => reject(new Error('Server startup timeout (30 s)')), 30000);
    serverModule.portReady
      .then(port => {
        clearTimeout(timer);
        actualPort = port;
        // Expose port to the preload script (set before window is created)
        process.env.ELECTRON_SERVER_PORT = String(port);
        console.log('[main] server ready on port', port);
        resolve();
      })
      .catch(err => { clearTimeout(timer); reject(err); });
  });
}

// ── Create the main window ────────────────────────────────────────────────
function createWindow() {
  // Preload script: runs before page JS, exposes server port via window.electronAPI
  // Unpacked so the OS can load it as a real file (preloads inside .asar can be tricky).
  const preloadPath = isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'electron', 'preload.js')
    : path.join(__dirname, 'preload.js');

  mainWindow = new BrowserWindow({
    width:           1200,
    height:          820,
    minWidth:        800,
    minHeight:       600,
    title:           'VideoForge',
    backgroundColor: '#0d0f14',
    show:            false,
    webPreferences: {
      preload:               preloadPath,
      contextIsolation:      true,
      nodeIntegration:       false,
      webSecurity:           true,
    }
  });

  // Hide default menu bar; we have a minimal one
  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'Open Downloads Folder', click: () => shell.openPath(path.join(app.getPath('userData'), 'outputs')) },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  ]);
  Menu.setApplicationMenu(menu);

  // In packaged builds, load the HTML directly from the known-good unpacked path.
  // This avoids relying on express.static to find docs/ (which silently 404s if
  // the DOCS_DIR env-var path doesn't match what electron-builder actually unpacked).
  // In dev, loadURL so the server hot-path works normally.
  if (isPackaged) {
    const htmlPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'docs', 'index.html');
    console.log('[main] loading file:', htmlPath);
    mainWindow.loadFile(htmlPath).catch(err => {
      console.error('[main] loadFile failed:', err.message);
      // Fallback: try HTTP in case docs aren't unpacked
      mainWindow.loadURL(`http://localhost:${actualPort}`);
    });
  } else {
    mainWindow.loadURL(`http://localhost:${actualPort}`);
  }

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Open external lin