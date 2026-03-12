#!/usr/bin/env bash
set -euo pipefail

echo "=== safe-openclaw installer ==="
echo "This will install/upgrade openclaw with security patches:"
echo "  - Mandatory password authentication (server-side)"
echo "  - Secret redaction from AI responses"
echo ""

# ── Node.js check ────────────────────────────────────────────────────────────
REQUIRED_MAJOR=22

check_node_version() {
  if ! command -v node &>/dev/null; then
    return 1
  fi
  local ver
  ver=$(node -v 2>/dev/null | sed 's/^v//')
  local major
  major=$(echo "$ver" | cut -d. -f1)
  if [ "$major" -ge "$REQUIRED_MAJOR" ] 2>/dev/null; then
    echo "  Node.js v${ver} detected. OK."
    return 0
  fi
  echo "  Node.js v${ver} detected, but v${REQUIRED_MAJOR}+ is required."
  return 1
}

install_node_via_nvm() {
  # Source nvm if available but not loaded
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
  fi

  if command -v nvm &>/dev/null; then
    echo "  nvm detected. Installing Node.js v${REQUIRED_MAJOR}..."
    nvm install "$REQUIRED_MAJOR"
    nvm use "$REQUIRED_MAJOR"
    return 0
  fi
  return 1
}

install_nvm_and_node() {
  echo "  Installing nvm..."
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  echo "  Installing Node.js v${REQUIRED_MAJOR} via nvm..."
  nvm install "$REQUIRED_MAJOR"
  nvm use "$REQUIRED_MAJOR"
}

echo "[1/3] Checking Node.js..."
if ! check_node_version; then
  if ! install_node_via_nvm; then
    install_nvm_and_node
  fi
  # Verify again
  if ! check_node_version; then
    echo "  ERROR: Failed to install Node.js v${REQUIRED_MAJOR}+. Please install manually:"
    echo "    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash"
    echo "    nvm install ${REQUIRED_MAJOR} && nvm use ${REQUIRED_MAJOR}"
    exit 1
  fi
fi

# ── npm check ────────────────────────────────────────────────────────────────
if ! command -v npm &>/dev/null; then
  echo "  ERROR: npm not found. Please install Node.js properly."
  exit 1
fi

# ── Install ──────────────────────────────────────────────────────────────────

# Uninstall upstream openclaw first to avoid conflicts
if npm ls -g openclaw --depth=0 &>/dev/null 2>&1; then
  echo ""
  echo "Removing upstream openclaw to avoid conflicts..."
  npm uninstall -g openclaw 2>/dev/null || true
fi

echo ""
echo "[2/3] Installing safe-openclaw..."
npm install -g safe-openclaw

# Create 'openclaw' symlink so both commands work
SAFE_BIN=$(command -v safe-openclaw 2>/dev/null)
if [ -n "$SAFE_BIN" ]; then
  BIN_DIR=$(dirname "$SAFE_BIN")
  if [ ! -e "$BIN_DIR/openclaw" ] || readlink "$BIN_DIR/openclaw" 2>/dev/null | grep -q safe-openclaw; then
    ln -sf "$SAFE_BIN" "$BIN_DIR/openclaw"
    echo "  Linked openclaw -> safe-openclaw"
  fi
fi

# Stop running gateway (if any)
pkill -f "openclaw gateway" 2>/dev/null && echo "  Stopped existing gateway." || true
sleep 1

# Verify
echo ""
echo "[3/3] Verifying installation..."
echo "  safe-openclaw:  $(command -v safe-openclaw 2>/dev/null || echo 'not found')"
echo "  openclaw:       $(command -v openclaw 2>/dev/null || echo 'not found')"

if ! command -v safe-openclaw &>/dev/null; then
  echo ""
  echo "  ERROR: Installation failed. safe-openclaw command not found."
  echo "  Try: npm install -g safe-openclaw"
  exit 1
fi

echo ""
echo "=== Installation complete ==="
echo ""
echo "Next steps:"
echo "  1. Set a password:    openclaw set-password"
echo "  2. Start the gateway: openclaw gateway run"
echo ""
echo "Run in background (keeps running after SSH disconnect):"
echo "  nohup openclaw gateway run > /tmp/openclaw-gateway.log 2>&1 &"
echo ""
echo "Or start the gateway first and set the password in your browser:"
echo "  openclaw gateway run"
echo "  # Open http://localhost:18789/setup"
