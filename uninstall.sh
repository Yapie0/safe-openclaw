#!/usr/bin/env bash
set -euo pipefail

echo "=== safe-openclaw uninstaller ==="
echo "This will remove safe-openclaw and restore upstream openclaw."
echo ""

# ── sudo detection ──────────────────────────────────────────────────────────
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  NPM_GLOBAL_DIR=$(npm prefix -g 2>/dev/null || echo "/usr/local")
  if [ ! -w "$NPM_GLOBAL_DIR/lib" ] 2>/dev/null; then
    SUDO="sudo"
  fi
fi

# ── Stop running gateway ────────────────────────────────────────────────────
echo "[1/4] Stopping gateway..."
if command -v openclaw &>/dev/null; then
  openclaw gateway stop 2>/dev/null && echo "  Stopped gateway via CLI." || true
fi
pkill -f "openclaw gateway" 2>/dev/null || true
sleep 1

# ── Remove safe-openclaw symlinks ───────────────────────────────────────────
echo "[2/4] Removing safe-openclaw..."

# Find and remove openclaw symlinks that point to safe-openclaw
OPENCLAW_BIN=$(command -v openclaw 2>/dev/null || true)
if [ -n "$OPENCLAW_BIN" ]; then
  if readlink "$OPENCLAW_BIN" 2>/dev/null | grep -q safe-openclaw; then
    echo "  Removing symlink: $OPENCLAW_BIN"
    $SUDO rm -f "$OPENCLAW_BIN"
  fi
fi

# Uninstall safe-openclaw npm package
if npm ls -g safe-openclaw --depth=0 &>/dev/null 2>&1; then
  echo "  Uninstalling safe-openclaw npm package..."
  $SUDO npm uninstall -g safe-openclaw
else
  echo "  safe-openclaw npm package not found, skipping."
fi

# ── Install upstream openclaw ───────────────────────────────────────────────
echo "[3/4] Installing upstream openclaw..."
$SUDO npm install -g openclaw

# ── Verify ──────────────────────────────────────────────────────────────────
echo ""
echo "[4/4] Verifying..."
echo "  openclaw: $(command -v openclaw 2>/dev/null || echo 'not found')"

if command -v openclaw &>/dev/null; then
  echo ""
  echo "=== Uninstall complete ==="
  echo ""
  echo "Upstream openclaw has been restored."
  echo "Your config at ~/.openclaw/ is preserved."
  echo ""
  echo "Note: API keys in config may still be encrypted (enc:v1:...)."
  echo "If openclaw cannot read them, you may need to manually replace"
  echo "the encrypted values with plaintext keys in ~/.openclaw/openclaw.json"
  echo ""
  echo "Start the gateway:"
  echo "  openclaw gateway run"
else
  echo ""
  echo "  WARNING: openclaw command not found after install."
  echo "  Try: npm install -g openclaw"
fi
