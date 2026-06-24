#!/usr/bin/env bash
set -e

CYAN='\033[0;36m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo ""
echo -e "${CYAN}  =========================================="
echo "    VideoForge  |  Local Transcoding Server"
echo -e "  ==========================================${NC}"
echo ""

# ── Check Node.js ──────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo -e "${RED}  [ERROR] Node.js is not installed.${NC}"
  echo ""
  echo "  Install via Homebrew:"
  echo "    brew install node"
  echo ""
  echo "  Or download from https://nodejs.org"
  echo ""

  # Offer to install via Homebrew if available
  if command -v brew &>/dev/null; then
    read -p "  Install Node.js now via Homebrew? [y/N] " yn
    if [[ "$yn" =~ ^[Yy]$ ]]; then
      brew install node
    else
      exit 1
    fi
  else
    open "https://nodejs.org"
    exit 1
  fi
fi

NODE_VER=$(node -v)
echo -e "${GREEN}  [OK] Node.js $NODE_VER${NC}"

# ── Check FFmpeg ────────────────────────────────────────────────────────────
if ! command -v ffmpeg &>/dev/null; then
  echo -e "${RED}  [ERROR] FFmpeg is not installed.${NC}"
  echo ""
  echo "  Install via Homebrew:"
  echo "    brew install ffmpeg"
  echo ""

  if command -v brew &>/dev/null; then
    read -p "  Install FFmpeg now via Homebrew? [y/N] " yn
    if [[ "$yn" =~ ^[Yy]$ ]]; then
      brew install ffmpeg
    else
      exit 1
    fi
  else
    echo "  Install Homebrew first: https://brew.sh"
    open "https://ffmpeg.org/download.html"
    exit 1
  fi
fi

FF_VER=$(ffmpeg -version 2>&1 | head -1)
echo -e "${GREEN}  [OK] $FF_VER${NC}"

# ── Locate server directory ─────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -f "server.js" ]; then
  echo -e "${RED}  [ERROR] server.js not found in $SCRIPT_DIR${NC}"
  echo "  Make sure launch-mac.sh is in the same folder as server.js"
  exit 1
fi

# ── Install dependencies ────────────────────────────────────────────────────
if [ ! -d "node_modules" ]; then
  echo ""
  echo -e "${YELLOW}  [SETUP] Installing dependencies (first run only)...${NC}"
  npm install
  echo -e "${GREEN}  [OK] Dependencies installed${NC}"
fi

# ── Server port (edit here or set PORT env var before running) ───────────────
export PORT=3000

# ── Start server ────────────────────────────────────────────────────────────
echo ""
echo -e "  Starting VideoForge server on ${CYAN}http://localhost:${PORT}${NC}"
echo -e "  Open your browser to: ${CYAN}https://cr4zysh4rk.github.io/video-transcoder/${NC}"
echo ""
echo "  Keep this window open while transcoding."
echo "  Press Ctrl+C to stop."
echo "  =========================================="
echo ""

# Open