# safe-openclaw

A security-hardened fork of [openclaw](https://github.com/openclaw/openclaw) that fixes the "naked public gateway" problem: out-of-the-box openclaw instances exposed to the internet have no mandatory password, leaving them open to anyone who finds the URL.

## What's different

| Feature | openclaw | safe-openclaw |
|---|---|---|
| First-time access | No password required | Must set a password before gateway opens |
| Password strength | None enforced | 8+ chars, upper + lower + digit |
| Auto-generated token | Silently written to config | Replaced by setup flow |
| Browser login | Token in URL/localStorage | Password → signed session token (3-day expiry) |
| Remote access without setup | Allowed | Blocked (403) |
| Password reset | No dedicated command | `set-password` (localhost only) |
| Migration from openclaw | N/A | `migrate` command |

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

Or via the API (from the gateway host):

```bash
curl -s -X POST http://localhost:18789/api/safe/reset-password \
  -H 'Content-Type: application/json' \
  -d '{"password":"NewStr0ngPass!"}'
```

## Session tokens

After login, the browser receives a signed session token valid for **3 days**. The token is stored in `localStorage` and sent as a `Bearer` token on subsequent requests. Restarting the gateway invalidates all existing session tokens (the signing secret rotates on each startup).

## Security notes

- Password reset and first-time setup endpoints are **localhost-only** — they return 403 for any remote request.
- The gateway is fully blocked (403) to remote clients until a password is set.
- Rate limiting on auth attempts is inherited from openclaw.
- HTTPS/TLS is strongly recommended when exposing the gateway beyond localhost. Use a reverse proxy (nginx, Caddy) or the built-in TLS option.

## Everything else

All other openclaw features work exactly the same. See the [openclaw docs](https://docs.openclaw.ai) for channels, skills, agents, and configuration.
