#!/usr/bin/env bash
set -euo pipefail

# safe-openclaw install & run — one-liner to install and start the gateway

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Step 1: Install ──────────────────────────────────────────────────────────
echo "=== safe-openclaw: install & run ==="
echo ""
bash "$SCRIPT_DIR/install.sh"

# ── Step 2: Source nvm (may have been installed by install.sh) ───────────────
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
fi

# ── Step 3: Start gateway in background ──────────────────────────────────────
echo ""
echo "=== Starting gateway in background ==="
bash "$SCRIPT_DIR/daemon.sh" start
echo ""
echo "=== All done ==="
echo ""
echo "Set your password at: http://localhost:18789/setup"
echo "Or via CLI:           openclaw set-password"
echo ""
echo "Manage the gateway:"
echo "  ./daemon.sh status   — check if running"
echo "  ./daemon.sh log      — view recent logs"
echo "  ./daemon.sh restart  — restart gateway"
echo "  ./daemon.sh stop     — stop gateway"
