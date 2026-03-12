# safe-openclaw — Project Guidelines

- Repo: https://github.com/Yapie0/safe-openclaw (fork of openclaw/openclaw)
- Upstream: https://github.com/openclaw/openclaw

## What is safe-openclaw

Security-hardened fork of openclaw. Key additions:

- Mandatory password auth gate (`src/gateway/safe-setup-handler.ts`)
- SHA-256 password hashing + AES-256-GCM API token encryption
- Secret redaction in outbound messages
- Localhost-only sensitive endpoints
- Password strength enforcement
- Auto-restart on password change

See `README.en.md` for full security patches documentation.

## Key files (safe-openclaw additions)

- `src/gateway/safe-setup-handler.ts` — auth gate, login/setup/reset pages, session management
- `src/gateway/safe-password-policy.ts` — password strength validation
- `src/gateway/safe-session.ts` — HMAC session tokens
- `src/cli/program/register.set-password.ts` — CLI set-password command
- `README.en.md` — security patches documentation
- `.github/workflows/safe-openclaw-npm-release.yml` — npm publish CI (triggers on `v*` tags)

## User preferences

- Default gateway startup command: `openclaw gateway run`
- Backup restart command: `openclaw gateway stop && openclaw gateway run`
- Default gateway port: 18789
- Git authors: Yapie0 and Claude only (no other authors in commits)
- Node version: use `source ~/.nvm/nvm.sh && nvm use 22` when Node 22 is needed
- npm account: yapie (uses passkey auth, publish via CI or `--auth-type=web`)

## Project Structure (openclaw core)

- Source: `src/` (CLI in `src/cli`, commands in `src/commands`, infra in `src/infra`, gateway in `src/gateway`)
- Tests: colocated `*.test.ts`
- Built output: `dist/`
- Plugins/extensions: `extensions/*`
- Config location: `~/.openclaw/openclaw.json`

## Build, Test, and Development

- Runtime: Node **22+**
- Install deps: `pnpm install`
- Build: `pnpm build`
- TypeScript checks: `pnpm tsgo`
- Lint/format: `pnpm check`
- Format fix: `pnpm format:fix`
- Tests: `pnpm test` (vitest)
- Run CLI in dev: `pnpm openclaw ...` or `pnpm dev`
- UI build: `pnpm ui:build`

## Coding Style

- Language: TypeScript (ESM). Strict typing; avoid `any`.
- Formatting/linting: Oxlint + Oxfmt; run `pnpm check` before commits.
- Never add `@ts-nocheck`; fix root causes.
- Add brief comments for tricky logic.
- Keep files under ~500 LOC when feasible.
- Naming: **OpenClaw** for product headings; `openclaw` for CLI/package/paths.

## Commit Guidelines

- Concise, action-oriented messages (e.g., `feat(safe-openclaw): add reset password UI`).
- Group related changes; avoid bundling unrelated refactors.
- Never commit secrets or real credentials.

## npm Release

- CI workflow triggers on `v*` tag push.
- Requires `NPM_TOKEN` secret in GitHub repo settings (granular access token).
- Verify: `npm view safe-openclaw version --userconfig "$(mktemp)"`

## Environment Notes

- Local Node may default to old version; always use nvm: `source ~/.nvm/nvm.sh && nvm use 22`
- Proxy set in environment (`http_proxy`); use `--noproxy localhost` for local curl.
- SSH remote: `git@github-yapie:Yapie0/safe-openclaw.git`
- Pre-commit hooks may error due to Node version mismatch (non-blocking).
