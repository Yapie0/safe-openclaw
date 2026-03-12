# safe-openclaw

A security-hardened fork of [openclaw](https://github.com/openclaw/openclaw) that fixes the "naked public gateway" problem: out-of-the-box openclaw instances exposed to the internet have no mandatory password, leaving them open to anyone who finds the URL.

## Security patches overview

### 1. Mandatory password auth gate

**Problem:** openclaw generates a random token on first run and writes it to the config file, but never forces the user to set a password. Anyone who discovers the gateway URL can access the full assistant.

**Fix:** safe-openclaw adds a server-side HTTP auth gate that intercepts **all** requests before they reach the gateway. The gateway is fully locked (403 for remote clients) until a password is set via the `/setup` page (localhost only). Browser sessions use signed session tokens (HMAC, 3-day expiry) stored in HttpOnly cookies.

- Setup page: `/setup` (localhost only, first-time)
- Login page: served automatically for unauthenticated browser requests
- Reset password: `/reset-password` (localhost only)
- Auth status API: `/api/safe/auth-status`
- WebSocket connections are also gated by session token

### 2. Password hashing (SHA-256) and API token encryption (AES-256-GCM)

**Problem:** openclaw stores the gateway auth token and all model API keys in plaintext in `~/.openclaw/openclaw.json`. Anyone with filesystem read access can steal credentials.

**Fix:** safe-openclaw hashes the gateway password with SHA-256 (with random salt) and uses the password hash as a key to AES-256-GCM encrypt all model API tokens (`env.*` values) in the config file. When the password is reset, all encrypted tokens are re-encrypted with the new key. The gateway automatically restarts after password changes to apply the new encryption keys.

- Password stored as: `sha256:<hex-salt>:<hex-hash>`
- API tokens stored as: `aes256gcm:<hex-iv>:<hex-authTag>:<hex-ciphertext>`
- Encryption key derived from password hash (first 32 bytes)

### 3. Secret redaction in outbound messages

**Problem:** the AI assistant might accidentally echo API keys, tokens, or passwords in chat responses, leaking secrets to messaging channels (WhatsApp, Telegram, etc.).

**Fix:** safe-openclaw scans all outbound messages before delivery and redacts any string that matches known secret patterns (API keys, tokens, passwords from the config). Secrets are replaced with `[REDACTED]` to prevent accidental leakage.

### 4. Password strength enforcement

**Problem:** openclaw allows any string as an auth token, including weak or empty values.

**Fix:** safe-openclaw enforces a password policy on all password set/reset operations:

- Minimum 8 characters
- At least one uppercase letter
- At least one lowercase letter
- At least one digit

### 5. Localhost-only sensitive endpoints

**Problem:** if password reset were available remotely, an attacker could reset the password over the network.

**Fix:** the `/setup`, `/reset-password`, and `/api/safe/reset-password` endpoints check the request origin and return 403 for any non-localhost request. This uses direct socket address inspection (with configurable trusted proxy support) to prevent IP spoofing via headers.

### 6. Auto-restart on password change

When the password is changed via the web UI, the gateway detects the config change and triggers an automatic restart (via SIGUSR1) to apply the new encryption keys. The reset password page includes a "Verify & continue" button that polls the gateway until it is back online, then redirects to the home page.

## What's different

| Feature                     | openclaw                   | safe-openclaw                                                   |
| --------------------------- | -------------------------- | --------------------------------------------------------------- |
| First-time access           | No password required       | Must set a password before gateway opens                        |
| Password storage            | Plaintext token in config  | SHA-256 hashed with random salt                                 |
| API token storage           | Plaintext in config        | AES-256-GCM encrypted with password-derived key                 |
| Password strength           | None enforced              | 8+ chars, upper + lower + digit                                 |
| Auto-generated token        | Silently written to config | Replaced by setup flow                                          |
| Browser login               | Token in URL/localStorage  | Password + signed session token (3-day expiry, HttpOnly cookie) |
| Remote access without setup | Allowed                    | Blocked (403)                                                   |
| Password reset              | No dedicated flow          | Web UI + CLI (localhost only)                                   |
| Secret leakage in chat      | No protection              | Outbound message redaction                                      |
| Migration from openclaw     | N/A                        | `migrate` command                                               |

## Install

```bash
npm install -g safe-openclaw
```

Both `safe-openclaw` and `openclaw` commands are available after install.

## First-time setup

### Browser

1. Start the gateway: `safe-openclaw gateway run`
2. Open `http://localhost:18789` — you'll be redirected to `/setup`
3. Set a strong password (8+ chars, upper + lower + digit)
4. Done — the gateway is now password-protected

### Command line

```bash
safe-openclaw set-password
# prompts for a new password, or:
safe-openclaw set-password --password 'YourStr0ngPass!'
```

Restart the gateway after changing the password.

## Migrating from openclaw

Your existing `~/.openclaw/` config, sessions, and channels carry over automatically — no files need to move.

```bash
# Check what needs to be done
safe-openclaw migrate --check

# Migrate (set a password)
safe-openclaw migrate --set-password 'YourStr0ngPass!'

# Or interactively
safe-openclaw set-password
```

Restart the gateway after migrating.

## Resetting a forgotten password

Password reset only works from localhost:

```bash
safe-openclaw set-password
```

Or via the browser: visit `http://localhost:18789/reset-password`.

Or via the API (from the gateway host):

```bash
curl -s -X POST http://localhost:18789/api/safe/reset-password \
  -H 'Content-Type: application/json' \
  -d '{"password":"NewStr0ngPass!"}'
```

After resetting, the gateway will restart automatically to apply the new encryption keys. If it does not restart, run:

```bash
openclaw gateway stop && openclaw gateway run
```

## Session tokens

After login, the browser receives a signed session token valid for **3 days**. The token is stored in an HttpOnly cookie (`openclaw_session`) and also returned in the JSON response for programmatic use as a Bearer token. Restarting the gateway invalidates all existing session tokens (the signing secret rotates on each startup).

## Common setup scenarios

### Initial configuration (doctor)

If the gateway refuses to start with `set gateway.mode=local`, run the interactive setup wizard:

```bash
openclaw doctor
```

This configures gateway mode, AI model, API keys, etc. Alternatively, skip the wizard:

```bash
openclaw gateway run --allow-unconfigured
```

### Exposing to the public internet

By default the gateway only listens on localhost. To expose it publicly:

1. Set `gateway.bind` to `lan` in `~/.openclaw/openclaw.json`:

```json
{
  "gateway": {
    "bind": "lan"
  }
}
```

2. **Set up HTTPS** — browsers require a secure context for full functionality (device identity, WebSocket). Use nginx or Caddy as a reverse proxy with TLS:

```nginx
# /etc/nginx/sites-available/openclaw-https
server {
    listen 443 ssl;
    server_name your-domain-or-ip;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 86400;
    }
}
```

3. Add `trustedProxies` so the gateway trusts the reverse proxy:

```json
{
  "gateway": {
    "bind": "lan",
    "trustedProxies": ["127.0.0.1"]
  }
}
```

4. Restart the gateway: `openclaw gateway stop && openclaw gateway run`

### Running as a systemd service

Create `/etc/systemd/system/openclaw-gateway.service`:

```ini
[Unit]
Description=safe-openclaw Gateway
After=network.target

[Service]
Type=simple
User=ubuntu
ExecStart=/usr/bin/openclaw gateway run
Restart=always
RestartSec=5
Environment=HOME=/home/ubuntu
WorkingDirectory=/home/ubuntu

[Install]
WantedBy=multi-user.target
```

Then enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable openclaw-gateway
sudo systemctl start openclaw-gateway
```

### Background scripts

The repo includes helper scripts for quick deployment:

- `daemon.sh` — manage the gateway as a background process (`start`/`stop`/`restart`/`status`/`log`)
- `installandrun.sh` — one-liner: install + start gateway in background

## Security notes

- Password reset and first-time setup endpoints are **localhost-only** — they return 403 for any remote request.
- The gateway is fully blocked (403) to remote clients until a password is set.
- Rate limiting on auth attempts is inherited from openclaw.
- HTTPS/TLS is strongly recommended when exposing the gateway beyond localhost. Use a reverse proxy (nginx, Caddy) or the built-in TLS option.

## Everything else

All other openclaw features work exactly the same. See the [openclaw docs](https://docs.openclaw.ai) for channels, skills, agents, and configuration.
