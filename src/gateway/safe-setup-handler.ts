/**
 * safe-openclaw: setup mode HTTP handlers.
 *
 * Exposes two local-only endpoints:
 *   POST /api/safe/setup          — first-time password setup (setup mode only)
 *   POST /api/safe/reset-password — reset password (always local-only)
 *
 * Also serves the setup page at GET /setup for browser users.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig, writeConfigFile } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { isLocalDirectRequest } from "./auth.js";
import { validateStrongPassword } from "./safe-password-policy.js";
import { issueSessionToken } from "./safe-session.js";

const SAFE_SETUP_PATH = "/api/safe/setup";
const SAFE_RESET_PATH = "/api/safe/reset-password";
const SAFE_SETUP_PAGE_PATH = "/setup";

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** Serve the browser setup page (HTML). */
function serveSetupPage(res: ServerResponse) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(SETUP_PAGE_HTML);
}

/**
 * Handle safe-openclaw setup endpoints.
 * Returns true if the request was handled.
 */
export async function handleSafeSetupRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    needsSetup: boolean;
    sessionSecret: string;
    trustedProxies?: string[];
  },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = (req.method ?? "GET").toUpperCase();
  const isLocal = isLocalDirectRequest(req, opts.trustedProxies ?? []);

  // Serve setup page for browser users (local only)
  if (path === SAFE_SETUP_PAGE_PATH && method === "GET") {
    if (!isLocal) {
      sendJson(res, 403, { ok: false, error: "Setup is only accessible from localhost" });
      return true;
    }
    serveSetupPage(res);
    return true;
  }

  // First-time setup endpoint
  if (path === SAFE_SETUP_PATH && method === "POST") {
    if (!isLocal) {
      sendJson(res, 403, { ok: false, error: "Setup is only accessible from localhost" });
      return true;
    }
    if (!opts.needsSetup) {
      sendJson(res, 409, { ok: false, error: "Password is already configured" });
      return true;
    }
    return handleSetPassword(req, res, opts.sessionSecret, "setup");
  }

  // Reset password endpoint (always local-only)
  if (path === SAFE_RESET_PATH && method === "POST") {
    if (!isLocal) {
      sendJson(res, 403, { ok: false, error: "Password reset is only accessible from localhost" });
      return true;
    }
    return handleSetPassword(req, res, opts.sessionSecret, "reset");
  }

  return false;
}

async function handleSetPassword(
  req: IncomingMessage,
  res: ServerResponse,
  sessionSecret: string,
  mode: "setup" | "reset",
): Promise<boolean> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
    return true;
  }

  const password =
    body != null && typeof body === "object" && "password" in body
      ? (body as Record<string, unknown>).password
      : undefined;

  if (typeof password !== "string") {
    sendJson(res, 400, { ok: false, error: "Missing password field" });
    return true;
  }

  const validation = validateStrongPassword(password);
  if (!validation.valid) {
    sendJson(res, 422, { ok: false, error: validation.error });
    return true;
  }

  // Persist password to config
  try {
    const cfg: OpenClawConfig = loadConfig();
    const nextCfg: OpenClawConfig = {
      ...cfg,
      gateway: {
        ...cfg.gateway,
        auth: {
          ...cfg.gateway?.auth,
          mode: "password",
          // Clear any auto-generated token when switching to password mode
          token: undefined,
          password,
        },
      },
    };
    await writeConfigFile(nextCfg);
  } catch (err) {
    sendJson(res, 500, { ok: false, error: `Failed to save config: ${String(err)}` });
    return true;
  }

  // Issue a session token so the user is immediately logged in
  const token = issueSessionToken(sessionSecret);
  sendJson(res, 200, {
    ok: true,
    mode,
    token,
    expiresIn: 3 * 24 * 60 * 60, // seconds
  });
  return true;
}

// ── Setup page HTML ──────────────────────────────────────────────────────────

const SETUP_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>safe-openclaw — Setup</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    background: #0f1117;
    color: #e2e8f0;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 1rem;
  }
  .card {
    background: #1a1d27;
    border: 1px solid #2d3148;
    border-radius: 12px;
    padding: 2rem;
    width: 100%;
    max-width: 400px;
  }
  h1 { font-size: 1.4rem; margin-bottom: 0.5rem; }
  .subtitle { color: #94a3b8; font-size: 0.875rem; margin-bottom: 1.5rem; }
  label { display: block; font-size: 0.875rem; margin-bottom: 0.4rem; color: #cbd5e1; }
  input[type=password] {
    width: 100%;
    padding: 0.6rem 0.75rem;
    background: #0f1117;
    border: 1px solid #2d3148;
    border-radius: 8px;
    color: #e2e8f0;
    font-size: 1rem;
    margin-bottom: 1rem;
    outline: none;
    transition: border-color 0.15s;
  }
  input[type=password]:focus { border-color: #6366f1; }
  .hint { font-size: 0.78rem; color: #64748b; margin-top: -0.75rem; margin-bottom: 1rem; }
  button {
    width: 100%;
    padding: 0.65rem;
    background: #6366f1;
    color: #fff;
    border: none;
    border-radius: 8px;
    font-size: 1rem;
    cursor: pointer;
    transition: background 0.15s;
  }
  button:hover { background: #4f46e5; }
  button:disabled { background: #374151; cursor: not-allowed; }
  .error { color: #f87171; font-size: 0.875rem; margin-bottom: 1rem; }
  .success { color: #4ade80; font-size: 0.875rem; margin-bottom: 1rem; }
</style>
</head>
<body>
<div class="card">
  <h1>🔒 safe-openclaw</h1>
  <p class="subtitle">Set a password to secure your gateway before going further.</p>
  <form id="form">
    <label for="pw">Password</label>
    <input type="password" id="pw" name="password" autocomplete="new-password" required>
    <p class="hint">8+ characters · uppercase · lowercase · digit</p>
    <label for="pw2">Confirm password</label>
    <input type="password" id="pw2" name="password2" autocomplete="new-password" required>
    <p id="msg" class="error" style="display:none"></p>
    <button type="submit" id="btn">Set password &amp; continue</button>
  </form>
</div>
<script>
  const form = document.getElementById('form');
  const pw = document.getElementById('pw');
  const pw2 = document.getElementById('pw2');
  const msg = document.getElementById('msg');
  const btn = document.getElementById('btn');

  function showError(text) {
    msg.textContent = text;
    msg.className = 'error';
    msg.style.display = '';
  }
  function showSuccess(text) {
    msg.textContent = text;
    msg.className = 'success';
    msg.style.display = '';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.style.display = 'none';
    if (pw.value !== pw2.value) {
      showError('Passwords do not match.');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const res = await fetch('/api/safe/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw.value }),
      });
      const data = await res.json();
      if (!data.ok) {
        showError(data.error || 'Unknown error');
        btn.disabled = false;
        btn.textContent = 'Set password & continue';
        return;
      }
      // Store session token and redirect to main app
      if (data.token) {
        localStorage.setItem('openclaw_token', data.token);
      }
      showSuccess('Password set! Redirecting…');
      setTimeout(() => { window.location.href = '/'; }, 800);
    } catch (err) {
      showError('Network error: ' + String(err));
      btn.disabled = false;
      btn.textContent = 'Set password & continue';
    }
  });
</script>
</body>
</html>
`;
