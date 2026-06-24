'use strict';

const { app, BrowserWindow, shell, ipcMain, dialog, Menu, Tray, nativeImage } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

// ── Resolve paths inside asar or dev ──────────────────────────────────────
const isPackaged = app.isPackaged;
const rootDir = isPackaged
  ? path.join(process.resourcesPath, 'app')
  : path.join(__dirname, '..');

// ── Override ffmpeg/ffprobe paths to use bundled binaries ─────────────────
// ffmpeg-static and ffprobe-static ship binaries for each platform.
// When packaged, they end up inside the asar; we point env vars to them.
try {
  const ffmpegPath  = require('ffmpeg-static');
  const ffprobePath = require('ffprobe-static').path;
  process.env.FFMPEG_PATH  = ffmpegPath;
  process.env.FFPROBE_PATH = ffprobePath;
  // Also add the directory to PATH so server.js can call ffmpeg directly
  const ffDir = path.dirname(ffmpegPath);
  process.env.PATH = ffDir + path.delimiter + (process.env.PATH || '');
} catch (e) {
  console.warn('ffmpeg-static not found, falling back to system FFmpeg:', e.message);
}

const PORT = 3000;
let serverProcess = null;
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
function startServer() {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(rootDir, 'server.js');

    // Spawn server.js with the same Node that's bundled in Electron
    serverProcess = spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        PORT:          String(PORT),
        ELECTRON_RUN:  '1',
        UPLOADS_DIR:   path.join(app.getPath('userData'), 'uploads'),
        OUTPUTS_DIR:   path.join(app.getPath('userData'), 'outputs'),
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    serverProcess.stdout.on('data', d => {
      const msg = d.toString().trim();
      console.log('[server]', msg);
      if (msg.includes('running at')) resolve();
    });

    serverProcess.stderr.on('data', d => console.error('[server-err]', d.toString()));

    serverProcess.on('error', reject);
    serverProcess.on('exit', code => {
      console.log(`[server] exited with code ${code}`);
      serverProcess = null;
    });

    // Fallback: resolve after polling that the server is up
    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      http.get(`http://localhost:${PORT}/api/health`, res => {
        if (res.statusCode === 200) { clearInterval(poll); resolve(); }
      }).on('error', () => {
        if (attempts > 30) { clearInterval(poll); reject(new Error('Server did not start')); }
      });
    }, 500);
  });
}

// ── Create the main window ────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width:           1200,
    height:          820,
    minWidth:        800,
    minHeight:       600,
    title:           'VideoForge',
    backgroundColor: '#0d0f14',
    show:            false,
    webPreferences: {
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

  mainWindow.loadURL(`http://localhost:${PORT}`);

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── App lifecycle ──────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  try {
    await startServer();
    createWindow();
  } catch (err) {
    dialog.showErrorBox(
      'VideoForge — Server Error',
      `Failed to start the local transcoding server:\n\n${err.message}\n\nPlease report this issue on GitHub.`
    );
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
});

app.on('will-quit', () => {
  if (serverProcess) {
    serverProcess.kill('SIGKILL');
    serverProcess = null;
  }
});
