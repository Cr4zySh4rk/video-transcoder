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

:: Not in PATH — check common install locations
set "NODE_PATHS="
set "NODE_PATHS=%NODE_PATHS%;%ProgramFiles%\nodejs\node.exe"
set "NODE_PATHS=%NODE_PATHS%;%ProgramFiles(x86)%\nodejs\node.exe"
set "NODE_PATHS=%NODE_PATHS%;%LOCALAPPDATA%\Programs\nodejs\node.exe"
set "NODE_PATHS=%NODE_PATHS%;%USERPROFILE%\AppData\Roaming\nvm\current\node.exe"
set "NODE_PATHS=%NODE_PATHS%;%USERPROFILE%\.nvm\current\node.exe"
set "NODE_PATHS=%NODE_PATHS%;%APPDATA%\nvm\node.exe"

for %%p in (%NODE_PATHS%) do (
    if exist "%%p" (
        set "NODE_EXE=%%p"
        :: Add its folder to PATH so npm works too
        for %%d in ("%%p") do set "PATH=%%~dpd;%PATH%"
        goto node_found
    )
)

echo  [ERROR] Node.js is not installed or not in PATH.
echo.
echo  Please install Node.js from https://nodejs.org
echo  Recommended: LTS version (v18 or later^)
echo.
echo  After installing, restart this script.
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

set "FFMPEG_PATHS="
set "FFMPEG_PATHS=%FFMPEG_PATHS%;C:\ffmpeg\bin\ffmpeg.exe"
set "FFMPEG_PATHS=%FFMPEG_PATHS%;C:\Program Files\ffmpeg\bin\ffmpeg.exe"
set "FFMPEG_PATHS=%FFMPEG_PATHS%;C:\Program Files (x86)\ffmpeg\bin\ffmpeg.exe"
set "FFMPEG_PATHS=%FFMPEG_PATHS%;%USERPROFILE%\ffmpeg\bin\ffmpeg.exe"
set "FFMPEG_PATHS=%FFMPEG_PATHS%;%LOCALAPPDATA%\Programs\ffmpeg\bin\ffmpeg.exe"

for %%p in (%FFMPEG_PATHS%) do (
    if exist "%%p" (
        set "FFMPEG_EXE=%%p"
        for %%d in ("%%p") do set "PATH=%%~dpd;%PATH%"
        goto ffmpeg_found
    )
)

echo.
echo  [ERROR] FFmpeg is not installed or not in PATH.
echo.
echo  Quick install via winget (run in a new terminal^):
echo    winget install Gyan.FFmpeg
echo.
echo  Or download from https://ffmpeg.org/download.html
echo  Extract and place ffmpeg.exe in C:\ffmpeg\bin, then re-run this script.
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

:: ── Locate server directory ─────────────────────────────────────────────
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

if not exist "server.js" (
    echo.
    echo  [ERROR] server.js not found in %SCRIPT_DIR%
    echo  Make sure launch-windows.bat is in the same folder as server.js.
    pause
    exit /b 1
)

:: ── Install npm dependencies ────────────────────────────────────────────
if not exist "node_modules" (
    echo.
    echo  [SETUP] Installing dependencies (first run only^)...
    call npm install
    if errorlevel 1 (
        echo.
        echo  [ERROR] npm install failed. Check your internet connection.
        pause
        exit /b 1
    )
    echo  [OK] Dependencies installed
)

:: ── Port (edit or patch via UI) ─────────────────────────────────────────
set PORT=3000

:: ── Start server ────────────────────────────────────────────────────────
echo.
echo  Starting VideoForge server on http://localhost:%PORT%
echo  Open your browser to: https://cr4zysh4rk.github.io/video-transcoder/
echo.
echo  Keep this window open while transcoding.
echo  Press Ctrl+C to stop.
echo  ==========================================
echo.

timeout /t 2 /nobreak >nul
start "" "https://cr4zysh4rk.github.io/video-transcoder/"

"%NODE_EXE%" server.js

echo.
echo  Server stopped.
pause
