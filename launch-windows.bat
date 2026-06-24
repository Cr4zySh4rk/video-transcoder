@echo off
setlocal enabledelayedexpansion
title VideoForge — Local Server

echo.
echo  ==========================================
echo    VideoForge  ^|  Local Transcoding Server
echo  ==========================================
echo.

:: ── Check Node.js ──────────────────────────────────────────────────────
where node >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Node.js is not installed or not in PATH.
    echo.
    echo  Please install Node.js from https://nodejs.org
    echo  Recommended: LTS version (v18 or later)
    echo.
    pause
    start https://nodejs.org
    exit /b 1
)

for /f "tokens=*" %%v in ('node -v 2^>^&1') do set NODE_VER=%%v
echo  [OK] Node.js %NODE_VER% found

:: ── Check FFmpeg ────────────────────────────────────────────────────────
where ffmpeg >nul 2>&1
if errorlevel 1 (
    echo.
    echo  [ERROR] FFmpeg is not installed or not in PATH.
    echo.
    echo  How to install FFmpeg on Windows:
    echo    1. Download from https://ffmpeg.org/download.html
    echo       (grab the "ffmpeg-release-essentials.7z" build)
    echo    2. Extract and copy the 'bin' folder contents to C:\ffmpeg\bin
    echo    3. Add C:\ffmpeg\bin to your System PATH environment variable
    echo    4. Restart this script
    echo.
    echo  Quick alternative — install via winget:
    echo    winget install Gyan.FFmpeg
    echo.
    pause
    start https://ffmpeg.org/download.html
    exit /b 1
)

for /f "tokens=*" %%v in ('ffmpeg -version 2^>^&1 ^| findstr /i "ffmpeg version"') do (
    set FF_VER=%%v
    goto ffmpeg_found
)
:ffmpeg_found
echo  [OK] %FF_VER%

:: ── Locate server directory ─────────────────────────────────────────────
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

if not exist "server.js" (
    echo.
    echo  [ERROR] server.js not found in %SCRIPT_DIR%
    echo  Make sure launch-windows.bat is in the same folder as server.js
    pause
    exit /b 1
)

:: ── Install dependencies ────────────────────────────────────────────────
if not exist "node_modules" (
    echo.
    echo  [SETUP] Installing dependencies (first run only)...
    call npm install
    if errorlevel 1 (
        echo.
        echo  [ERROR] npm install failed. Check your internet connection.
        pause
        exit /b 1
    )
    echo  [OK] Dependencies installed
)

:: ── Start server ────────────────────────────────────────────────────────
echo.
echo  Starting VideoForge server on http://localhost:3000
echo  Open your browser to: https://cr4zysh4rk.github.io/video-transcoder/
echo.
echo  Keep this window open while transcoding.
echo  Press Ctrl+C to stop the server.
echo  ==========================================
echo.

:: Open browser automatically
timeout /t 2 /nobreak >nul
start "" "https://cr4zysh4rk.github.io/video-transcoder/"

node server.js

echo.
echo  Server stopped.
pause
