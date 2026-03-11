#!/usr/bin/env bash
set -euo pipefail

echo "=== safe-openclaw installer ==="
echo "This will install/upgrade openclaw with security patches:"
echo "  - Mandatory password authentication (server-side)"
echo "  - Secret redaction from AI responses"
echo ""

# Check if openclaw is already installed
HAS_OPENCLAW=false
if command -v openclaw &>/dev/null; then
  HAS_OPENCLAW=true
  echo "Detected existing openclaw installation, will upgrade in place."
fi

# Install safe-openclaw as openclaw (alias install)
echo ""
echo "[1/4] Installing safe-openclaw..."
npm install -g openclaw@npm:safe-openclaw

# If user didn't have openclaw before, also install under safe-openclaw name
# so both commands work
if [ "$HAS_OPENCLAW" = false ]; then
  echo "  First-time install: registering both 'openclaw' and 'safe-openclaw' commands."
  npm install -g safe-openclaw
fi

# Stop running gateway (if any)
echo ""
echo "[2/4] Stopping existing gateway..."
pkill -f "openclaw gateway" 2>/dev/null && echo "  Stopped." || echo "  No running gateway found."
sleep 1

# Verify
echo ""
echo "[3/4] Verifying installation..."
echo "  openclaw:      $(command -v openclaw 2>/dev/null || echo 'not found')"
echo "  safe-openclaw:  $(command -v safe-openclaw 2>/dev/null || echo 'not found')"

# Start gateway
echo ""
echo "[4/4] Starting gateway..."
openclaw gateway run &
GATEWAY_PID=$!
sleep 3

if kill -0 "$GATEWAY_PID" 2>/dev/null; then
  echo "  Gateway started (PID $GATEWAY_PID)."
else
  echo "  Gateway failed to start. Check logs and run manually:"
  echo "    openclaw gateway run"
fi

echo ""
echo "=== Done ==="
echo "If this is your first time, open http://localhost:18789/setup to set a password."
echo "Otherwise, log in with your existing password."
