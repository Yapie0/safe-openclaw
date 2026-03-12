**[中文](README.md)** | English

# safe-openclaw

> **Security architecture layer for [openclaw](https://github.com/openclaw/openclaw).**
> openclaw ships with zero authentication, plaintext API keys, and no secret protection — deploy it on a server and anyone who discovers the URL owns your AI gateway and every API key in it.
> safe-openclaw adds a full security architecture: mandatory auth gate, AES-256 token encryption, session management, secret redaction, and password-gated access — all as a drop-in replacement with zero config migration.

<p align="center">
  <a href="https://github.com/Yapie0/safe-openclaw/releases"><img src="https://img.shields.io/github/v/release/Yapie0/safe-openclaw?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
  <a href="https://www.npmjs.com/package/safe-openclaw"><img src="https://img.shields.io/npm/v/safe-openclaw?style=for-the-badge&color=cb3837" alt="npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

## Already running openclaw? One command to patch it

No need to uninstall anything. The installer checks your Node.js environment and detects your existing openclaw, upgrades it in place with all security patches — your config, sessions, and channels are preserved:

```bash
curl -fsSL https://raw.githubusercontent.com/Yapie0/safe-openclaw/main/install.sh | bash
```

What the installer does:
1. Checks Node.js >= 22, auto-installs via nvm if needed
2. Installs safe-openclaw as a drop-in replacement for openclaw (`npm install -g openclaw@npm:safe-openclaw`)
3. Stops any running gateway
4. Prints next steps

After the upgrade, the `openclaw` command is now safe-openclaw under the hood. All your existing config and channels keep working.

## Fresh install

```bash
curl -fsSL https://raw.githubusercontent.com/Yapie0/safe-openclaw/main/install.sh | bash
```

Or install manually (requires **Node >= 22**):

```bash
npm install -g safe-openclaw
```

Both `openclaw` and `safe-openclaw` commands are available after install.

### Set a password

```bash
# Option A: set password from terminal
openclaw set-password

# Option B: start gateway, set password in browser
openclaw gateway run
# First visit to http://localhost:18789 → redirected to /setup
```

### Start the gateway

```bash
# Foreground
openclaw gateway run

# Background (survives SSH disconnect)
nohup openclaw gateway run > /tmp/openclaw-gateway.log 2>&1 &
```

## What's different

| Feature | openclaw | safe-openclaw |
|---|---|---|
| First-time access | No password required | Must set a password before gateway opens |
| Password storage | Plaintext token in config | SHA-256 hashed with random salt |
| API token storage | Plaintext in config | AES-256-GCM encrypted with password-derived key |
| Password strength | None enforced | 8+ chars, upper + lower + digit |
| Browser login | Token in URL/localStorage | Password + signed session token (3-day expiry, HttpOnly cookie) |
| Remote access without setup | Allowed | Blocked (403) |
| Password reset | No dedicated flow | Web UI + CLI (localhost only) |
| Secret leakage in chat | No protection | Outbound message redaction |

## Security patches

### 1. Mandatory password auth gate

openclaw generates a random token on first run but never forces the user to set a password. safe-openclaw adds a server-side HTTP auth gate that intercepts **all** requests before they reach the gateway. The gateway is fully locked (403 for remote clients) until a password is set.

- First visit redirects to `/setup` (localhost only)
- Unauthenticated browser requests get the login page
- API requests without a valid token receive 401
- WebSocket connections are also gated by session token

### 2. Password hashing + API token encryption

openclaw stores the auth token and all model API keys in **plaintext** in `~/.openclaw/openclaw.json`.

safe-openclaw:
- Hashes passwords with **SHA-256** (random salt): `sha256:<salt>:<hash>`
- Encrypts all model API tokens with **AES-256-GCM** using a password-derived key: `aes256gcm:<iv>:<authTag>:<ciphertext>`
- Re-encrypts all tokens when the password changes

### 3. Secret redaction in outbound messages

The AI assistant might accidentally echo API keys or passwords in chat responses. safe-openclaw scans all outbound messages and replaces known secret patterns with `**********` before delivery to any channel.

### 4. Password strength enforcement

All password set/reset operations enforce: minimum 8 characters, at least one uppercase, one lowercase, and one digit.

### 5. Localhost-only sensitive endpoints

`/setup`, `/reset-password`, and `/api/safe/reset-password` check the request origin via direct socket address inspection and return 403 for any non-localhost request.

### 6. Auto-restart on password change

When the password is changed via the web UI, the gateway detects the config change and triggers an automatic restart to apply the new encryption keys. The reset page includes a "Verify & continue" button that polls until the gateway is back online.

## Migrating from openclaw

Your existing `~/.openclaw/` config, sessions, and channels carry over automatically.

```bash
openclaw migrate --check
openclaw migrate --set-password 'YourStr0ngPass!'
```

## Resetting a forgotten password

Password reset only works from localhost:

```bash
openclaw set-password
```

Or visit `http://localhost:18789/reset-password` in a browser on the gateway host.

After resetting, the gateway restarts automatically. If it does not, run:

```bash
openclaw gateway stop && openclaw gateway run
```

## From source

```bash
git clone https://github.com/Yapie0/safe-openclaw.git
cd safe-openclaw

pnpm install
pnpm build

pnpm openclaw gateway run
```

## Everything else

All other openclaw features (channels, skills, agents, tools, apps) work exactly the same. See the [openclaw docs](https://docs.openclaw.ai) for details.

## License

[MIT](LICENSE)
