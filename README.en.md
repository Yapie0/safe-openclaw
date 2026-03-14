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

## What's different

| Feature                     | openclaw                             | safe-openclaw                                                            |
| --------------------------- | ------------------------------------ | ------------------------------------------------------------------------ |
| First-time access           | No password required                 | Must set a password before gateway opens                                 |
| Password storage            | Plaintext token in config            | SHA-256 hashed with random salt                                          |
| API token storage           | Plaintext in config                  | AES-256-GCM encrypted with password-derived key                          |
| Password strength           | None enforced                        | 8+ chars, upper + lower + digit                                          |
| Browser login               | Token in URL/localStorage            | Password + signed session token (3-day expiry, HttpOnly cookie)          |
| Remote access without setup | Allowed                              | Blocked (403)                                                            |
| Password reset              | No dedicated flow                    | Web UI + CLI (localhost only)                                            |
| Secret leakage in chat      | No protection                        | Outbound message redaction                                               |
| Model API configuration     | Manually edit JSON config            | One command: interactive setup, connection test, auto-encryption         |
| Runtime isolation           | None — tools have full system access | Docker container isolation, malicious code cannot access host            |
| Tool call safety            | No protection                        | Security Shield: dangerous command blocking + leak detection + audit log |
| Tool execution isolation    | No protection                        | Execution Isolation: filesystem/network/command allowlist policies       |

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

## Security Shield Plugin (built-in)

safe-openclaw ships with a built-in **Security Shield** plugin that provides real-time security protection for AI tool calls:

### Dangerous Command Blocking

Automatically detects and blocks high-risk operations: `rm -rf /`, `curl|bash` pipe execution, reverse shells, and more. All tool call parameters are scanned before execution — critical-severity matches are blocked immediately.

### Secret Leak Detection

Scans tool output and outbound messages for sensitive patterns (API keys, tokens, private keys, etc.) and replaces them with `**********`, preventing the AI from accidentally leaking secrets in conversations.

### Audit Logging

All tool calls are logged to an audit trail, including tool name, parameters (redacted), execution result, block status and reason — enabling post-incident security review.

### Configuration

Configure in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "security-shield": {
      "enforcement": "block",
      "auditLog": true,
      "leakDetection": true
    }
  }
}
```

| Option          | Description                                                     | Default   |
| --------------- | --------------------------------------------------------------- | --------- |
| `enforcement`   | `"block"` to block / `"warn"` to warn only / `"off"` to disable | `"block"` |
| `auditLog`      | Enable audit logging                                            | `true`    |
| `leakDetection` | Enable secret leak detection                                    | `true`    |

## Execution Isolation Plugin (built-in)

The **Execution Isolation** plugin provides policy-based access control for AI tool calls, complementing Security Shield — Shield catches pattern-based attacks, Isolation enforces structural access control via allowlists/denylists.

### Filesystem Policy

Controls which paths the AI can read/write. Deny rules take precedence over allow rules. Supports `~` expansion and path traversal protection.

### Network Policy

Controls which domains the AI can access. Supports wildcard matching (e.g., `*.github.com`), preventing data exfiltration to unauthorized servers.

### Command Policy

Controls which commands the AI can execute. Automatically detects `sh -c`, `bash -c` wrappers and `env` prefixes, extracting the real command for matching.

### Configuration

Configure in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "execution-isolation": {
      "enforcement": "block",
      "defaultAction": "allow",
      "filesystem": {
        "readAllow": ["~/workspace", "/tmp", "~/.openclaw"],
        "writeAllow": ["~/workspace", "/tmp"],
        "deny": ["~/.ssh", "~/.aws", "~/.gnupg"]
      },
      "network": {
        "allow": ["api.openai.com", "api.anthropic.com", "*.github.com"],
        "deny": ["10.*", "192.168.*"]
      },
      "commands": {
        "allow": ["node", "python", "git", "pnpm", "npm", "curl"],
        "deny": ["sudo", "chmod", "chown"]
      }
    }
  }
}
```

| Option          | Description                                                     | Default   |
| --------------- | --------------------------------------------------------------- | --------- |
| `enforcement`   | `"block"` to block / `"warn"` to warn only / `"off"` to disable | `"block"` |
| `defaultAction` | Default action when no rule matches                             | `"allow"` |
| `auditLog`      | Enable audit logging                                            | `true`    |

> **Compatibility note:** Execution Isolation works at the tool execution layer without modifying OpenClaw's plugin interface, so it's fully compatible with existing Skill Hub skills.

## Docker isolated deployment (recommended for production)

AI agents can execute code, invoke tools, and read/write files. openclaw applies no isolation to these operations — the AI has the same system privileges as you. A single malicious instruction could delete files, read private keys, or install a backdoor. Community extensions may also contain malicious code.

**Docker deployment runs the entire gateway in an isolated container** — even if an extension contains malicious code, it cannot access sensitive files or system resources on the host.

### Quick start

```bash
# 1. Build the image
git clone https://github.com/Yapie0/safe-openclaw.git
cd safe-openclaw
docker build -t safe-openclaw .

# 2. Create config and workspace directories
mkdir -p ~/.openclaw ~/.openclaw/workspace

# 3. Start the container
docker run -d \
  --name safe-openclaw \
  --restart unless-stopped \
  -p 18789:18789 \
  -v ~/.openclaw:/home/node/.openclaw \
  -v ~/.openclaw/workspace:/home/node/.openclaw/workspace \
  safe-openclaw \
  node openclaw.mjs gateway --bind lan --allow-unconfigured
```

Visit `http://localhost:18789` to set your password.

### Using docker-compose

```bash
# Create .env file
cat > .env << 'EOF'
OPENCLAW_IMAGE=safe-openclaw
OPENCLAW_CONFIG_DIR=~/.openclaw
OPENCLAW_WORKSPACE_DIR=~/.openclaw/workspace
OPENCLAW_GATEWAY_PORT=18789
OPENCLAW_BRIDGE_PORT=18790
OPENCLAW_GATEWAY_BIND=lan
EOF

# Start
docker compose up -d openclaw-gateway
```

### Running CLI commands inside the container

```bash
# Set password
docker exec -it safe-openclaw node openclaw.mjs set-password

# Run doctor
docker exec -it safe-openclaw node openclaw.mjs doctor

# View logs
docker logs -f safe-openclaw
```

### What Docker isolates

| Threat                                  | Without Docker   | With Docker                    |
| --------------------------------------- | ---------------- | ------------------------------ |
| Malicious extension reads `~/.ssh`      | ⚠️ Can read      | ✅ Directory not in container  |
| Malicious extension reads `/etc/passwd` | ⚠️ Can read      | ✅ Isolated filesystem         |
| `rm -rf /` deletes system files         | ⚠️ Executes      | ✅ Only affects container      |
| Malicious code installs backdoor        | ⚠️ Host infected | ✅ Destroyed with container    |
| Stealing other process info             | ⚠️ Accessible    | ✅ Process namespace isolation |

> **Note:** The container can read/write the mounted `~/.openclaw` directory. Do not mount `~/.ssh`, `~/.aws`, or other sensitive directories into the container.

---

## Already running openclaw? One command to patch it

No need to uninstall anything. The installer checks your Node.js environment and detects your existing openclaw, upgrades it in place with all security patches — your config, sessions, and channels are preserved:

```bash
curl -fsSL https://raw.githubusercontent.com/Yapie0/safe-openclaw/main/install.sh | bash
```

What the installer does:

1. Checks Node.js >= 22, auto-installs via nvm if needed
2. Stops any running gateway
3. Uninstalls upstream openclaw and installs safe-openclaw (`npm install -g safe-openclaw`)
4. Creates `openclaw` symlink so both commands work
5. Prints next steps

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

### Configure model API key

After setting a password, configure your model API key with one command (auto-encrypted):

```bash
curl -fsSL https://raw.githubusercontent.com/Yapie0/safe-openclaw/main/scripts/safe-set-model.sh | bash
```

Supports Anthropic, OpenAI, Google Gemini, Qwen, DeepSeek, OpenRouter, and more. See [One-command model API setup](#one-command-model-api-setup) below.

### Set up a messaging channel (Telegram example)

1. Open [@BotFather](https://t.me/BotFather) in Telegram, send `/newbot`, follow the prompts to get a Bot Token
2. Edit `~/.openclaw/openclaw.json` and add `channels.telegram`:

```json
{
  "channels": {
    "telegram": {
      "botToken": "123456789:AABBccDDeeFFggHH",
      "dmPolicy": "open",
      "allowFrom": ["*"]
    }
  }
}
```

| Field         | Description                                                       |
| ------------- | ----------------------------------------------------------------- |
| `botToken`    | Bot Token from BotFather                                          |
| `dmPolicy`    | `"open"` allows everyone, `"allowlist"` restricts to listed users |
| `allowFrom`   | `["*"]` for everyone, or an array of Telegram user IDs            |
| `groupPolicy` | Group policy: `"open"` / `"allowlist"` / `"disabled"`             |

> Other supported channels: Slack, Discord, WhatsApp, iMessage, etc. See [openclaw docs](https://docs.openclaw.ai).

### Start the gateway

```bash
# Foreground
openclaw gateway run

# Background (survives SSH disconnect)
nohup openclaw gateway run > /tmp/openclaw-gateway.log 2>&1 &
```

## One-command model API setup

After installing and setting a password, configure any model's API key with a single command — interactive provider selection, automatic connection test with a real `hello` message, and AES-256-GCM encrypted storage:

```bash
curl -fsSL https://raw.githubusercontent.com/Yapie0/safe-openclaw/main/scripts/safe-set-model.sh | bash
```

Supported providers: **Anthropic**, **OpenAI**, **Google Gemini**, **Qwen (Tongyi)**, **DeepSeek**, **OpenRouter**, **Mistral**, **xAI (Grok)**, **Together**, **OpenCode**.

The script will:

1. Verify a password hash exists (prompts to run `openclaw set-password` if not)
2. Let you pick a provider, enter Base URL and API Key
3. Send `hello` to the model and display its reply to verify connectivity
4. Encrypt the API Key with AES-256-GCM using the existing password hash
5. Write `models.providers` config and set it as the default model

Run it multiple times to configure different providers. Custom Base URLs are supported for proxies and mirrors.

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

## Common operations

### Initial configuration (doctor)

If the gateway refuses to start with `set gateway.mode=local`, run the interactive setup wizard:

```bash
openclaw doctor
```

This guides you through gateway mode, AI model, and API key configuration.

Or skip the wizard and start directly:

```bash
openclaw gateway run --allow-unconfigured
```

> **Note:** safe-openclaw 1.0.8+ defaults to local mode automatically, so this is usually not needed.

### Exposing to the public internet

By default the gateway only listens on localhost. To expose it publicly:

**1. Set `gateway.bind` to `lan` in `~/.openclaw/openclaw.json`:**

```json
{
  "gateway": {
    "bind": "lan"
  }
}
```

**2. Set up HTTPS** — browsers require a secure context for full functionality:

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

**3. Add `trustedProxies` so the gateway trusts the reverse proxy:**

```json
{
  "gateway": {
    "bind": "lan",
    "trustedProxies": ["127.0.0.1"]
  }
}
```

**4. Restart the gateway:**

```bash
openclaw gateway stop && openclaw gateway run
```

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

## Uninstall safe-openclaw

To remove safe-openclaw and restore upstream openclaw:

```bash
curl -fsSL https://raw.githubusercontent.com/Yapie0/safe-openclaw/main/uninstall.sh | bash
```

The uninstall script will:

1. Stop the running gateway
2. Uninstall the safe-openclaw npm package
3. Install upstream openclaw
4. Preserve your `~/.openclaw/` config

> **Note:** Encrypted API keys (`enc:v1:...`) in config are not recognized by upstream openclaw. You will need to manually replace them with plaintext values.

## Everything else

All other openclaw features (channels, skills, agents, tools, apps) work exactly the same. See the [openclaw docs](https://docs.openclaw.ai) for details.

## License

[MIT](LICENSE)
