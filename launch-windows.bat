@echo off
setlocal enabledelayedexpansion
title VideoForge — Local Server

echo.
echo  ==========================================
echo    VideoForge  ^|  Local Transcoding Server
echo  ==========================================
echo.

:: ── Find Node.js ───────────────────────────────────────────────────────
set "NODE_EXE=node"

where node >nul 2>&1
if not errorlevel 1 goto node_found

if exist "%ProgramFiles%\nodejs\node.exe" (
    set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
    set "PATH=%ProgramFiles%\nodejs;%PATH%"
    goto node_found
)
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" (
    set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
    set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
    goto node_found
)
if exist "%ProgramFiles(x86)%\nodejs\node.exe" (
    set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
    set "PATH=%ProgramFiles(x86)%\nodejs;%PATH%"
    goto node_found
)
if exist "%APPDATA%\nvm\current\node.exe" (
    set "NODE_EXE=%APPDATA%\nvm\current\node.exe"
    set "PATH=%APPDATA%\nvm\current;%PATH%"
    goto node_found
)

echo  [ERROR] Node.js is not installed or not in PATH.
echo  Install from https://nodejs.org then re-run this script.
echo.
pause
start https://nodejs.org
exit /b 1

:node_found
for /f "tokens=*" %%v in ('"%NODE_EXE%" -v 2^>^&1') do set NODE_VER=%%v
echo  [OK] Node.js %NODE_VER%

:: ── Find FFmpeg ─────────────────────────────────────────────────────────
set "FFMPEG_EXE=ffmpeg"

where ffmpeg >nul 2>&1
if not errorlevel 1 goto ffmpeg_found

if exist "C:\ffmpeg\bin\ffmpeg.exe" (
    set "FFMPEG_EXE=C:\ffmpeg\bin\ffmpeg.exe"
    set "PATH=C:\ffmpeg\bin;%PATH%"
    goto ffmpeg_found
)
if exist "%ProgramFiles%\ffmpeg\bin\ffmpeg.exe" (
    set "FFMPEG_EXE=%ProgramFiles%\ffmpeg\bin\ffmpeg.exe"
    set "PATH=%ProgramFiles%\ffmpeg\bin;%PATH%"
    goto ffmpeg_found
)
if exist "%USERPROFILE%\ffmpeg\bin\ffmpeg.exe" (
    set "FFMPEG_EXE=%USERPROFILE%\ffmpeg\bin\ffmpeg.exe"
    set "PATH=%USERPROFILE%\ffmpeg\bin;%PATH%"
    goto ffmpeg_found
)

echo.
echo  [ERROR] FFmpeg not found. Install via: winget install Gyan.FFmpeg
echo  Then re-run this script.
echo.
pause
start https://ffmpeg.org/download.html
exit /b 1

:ffmpeg_found
for /f "tokens=*" %%v in ('"%FFMPEG_EXE%" -version 2^>^&1 ^| findstr /i "ffmpeg version"') do (
    set FF_VER=%%v
    goto ffmpeg_ok
)
:ffmpeg_ok
echo  [OK] %FF_VER%

:: ── Set working directory ───────────────────────────────────────────────
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

:: ── Auto-download server files if missing ──────────────────────────────
if exist "server.js" goto server_ready

echo.
echo  [SETUP] server.js not found — downloading server files from GitHub...

where curl >nul 2>&1
if errorlevel 1 goto no_curl

set "BASE=https://raw.githubusercontent.com/Cr4zySh4rk/video-transcoder/main"

echo  Downloading server.js...
curl -fsSL "%BASE%/server.js" -o server.js
if errorlevel 1 goto dl_fail

echo  Downloading package.json...
curl -fsSL "%BASE%/package.json" -o package.json
if errorlevel 1 goto dl_fail

echo  [OK] Server files downloaded.
goto server_ready

:no_curl
echo  [ERROR] curl not found. Please download the full release zip from:
echo  https://github.com/Cr4zySh4rk/video-transcoder/releases
echo  Extract it, then run launch-windows.bat from that folder.
pause
exit /b 1

:dl_fail
echo  [ERROR] Download failed. Check your internet connection.
echo  Or get the zip from: https://github.com/Cr4zySh4rk/video-transcoder/releases
pause
exit /b 1

:server_ready

:: ── Install npm dependencies ────────────────────────────────────────────
if exist "node_modules" goto deps_ready

echo.
echo  [SETUP] Installing dependencies (first run only)...
call npm install
if errorlevel 1 (
    echo  [ERROR] npm install failed. Check your internet connection.
    pause
    exit /b 1
)
echo  [OK] Dependencies installed

:deps_ready

:: ── Port ────────────────────────────────────────────────────────────────
set PORT=3000

:: ── Start server ────────────────────────────────────────────────────────
echo.
echo  Starting VideoForge on http://localhost:%PORT%
echo  Browser: https://cr4zysh4rk.github.io/video-transcoder/
echo.
echo  Keep this window open while transcoding. Ctrl+C to stop.
echo  ==========================================
echo.

timeout /t 2 /nobreak >nul
start "" "https://cr4zysh4rk.github.io/video-transcoder/"

"%NODE_EXE%" server.js

echo.
echo  Server stopped.
pause
