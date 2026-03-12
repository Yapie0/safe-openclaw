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

# Use sudo for npm global installs when not root and Node is system-installed
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  NPM_GLOBAL_DIR=$(npm prefix -g 2>/dev/null || echo "/usr/local")
  if [ ! -w "$NPM_GLOBAL_DIR/lib" ] 2>/dev/null; then
    SUDO="sudo"
    echo "  Non-root user detected, will use sudo for npm install."
  fi
fi

# Uninstall upstream openclaw from all known npm prefixes
uninstall_upstream_openclaw() {
  # Try npm ls first (covers the current npm prefix)
  if npm ls -g openclaw --depth=0 &>/dev/null 2>&1; then
    echo "  Removing upstream openclaw (npm prefix: $(npm prefix -g))..."
    $SUDO npm uninstall -g openclaw 2>/dev/null || true
  fi
  # Also check if an openclaw binary exists elsewhere in PATH that is NOT safe-openclaw
  local existing
  existing=$(command -v openclaw 2>/dev/null || true)
  if [ -n "$existing" ]; then
    # If it's a symlink to safe-openclaw, it's ours — skip
    if readlink "$existing" 2>/dev/null | grep -q safe-openclaw; then
      return
    fi
    # Check if it's the upstream package by looking for set-password command
    if ! "$existing" set-password --help &>/dev/null 2>&1; then
      echo "  Found upstream openclaw at $existing, replacing..."
      $SUDO rm -f "$existing"
    fi
  fi
}

# Stop running gateway before install to avoid file locks and conflicts
if command -v openclaw &>/dev/null; then
  openclaw gateway stop 2>/dev/null && echo "  Stopped gateway via CLI." || true
fi
pkill -f "openclaw gateway" 2>/dev/null || true
sleep 1

echo ""
echo "Removing upstream openclaw to avoid conflicts..."
uninstall_upstream_openclaw

echo ""
echo "[2/3] Installing safe-openclaw..."
$SUDO npm install -g safe-openclaw

# Replace ALL openclaw binaries in PATH with symlinks to safe-openclaw
SAFE_BIN=$(command -v safe-openclaw 2>/dev/null)
if [ -n "$SAFE_BIN" ]; then
  # Link in the same directory as safe-openclaw
  BIN_DIR=$(dirname "$SAFE_BIN")
  $SUDO ln -sf "$SAFE_BIN" "$BIN_DIR/openclaw"
  echo "  Linked $BIN_DIR/openclaw -> safe-openclaw"

  # Check if another openclaw still shadows ours in PATH
  ACTUAL=$(command -v openclaw 2>/dev/null || true)
  if [ -n "$ACTUAL" ] && [ "$ACTUAL" != "$BIN_DIR/openclaw" ]; then
    # Another openclaw exists at a higher-priority PATH location
    if ! readlink "$ACTUAL" 2>/dev/null | grep -q safe-openclaw; then
      echo "  Replacing shadowing openclaw at $ACTUAL..."
      $SUDO ln -sf "$SAFE_BIN" "$ACTUAL"
    fi
  fi
fi

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
