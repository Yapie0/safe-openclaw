/**
 * safe-openclaw: HTTP auth gate, login, setup, and reset-password handlers.
 *
 * Endpoints:
 *   GET  /setup               — first-time password setup page (local only)
 *   POST /api/safe/setup      — first-time password setup API (local only, setup mode only)
 *   POST /api/safe/login      — password login, returns session token
 *   POST /api/safe/reset-password — reset password (local only)
 *   GET  /api/safe/auth-status — check current auth state (no credentials needed)
 *
 * Auth gate:
 *   All other HTTP requests are blocked unless a valid session token cookie
 *   (`openclaw_session`) or Bearer token is present.  Unauthenticated browser
 *   requests receive the login page; API requests receive 401 JSON.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig, writeConfigFile } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { isLocalDirectRequest } from "./auth.js";
import { validateStrongPassword } from "./safe-password-policy.js";
import { issueSessionToken, verifySessionToken } from "./safe-session.js";

const SAFE_SETUP_PATH = "/api/safe/setup";
const SAFE_LOGIN_PATH = "/api/safe/login";
const SAFE_RESET_PATH = "/api/safe/reset-password";
const SAFE_AUTH_STATUS_PATH = "/api/safe/auth-status";
const SAFE_SETUP_PAGE_PATH = "/setup";
const SESSION_COOKIE_NAME = "openclaw_session";
const SESSION_TTL_SECONDS = 3 * 24 * 60 * 60;

// ── Helpers ──────────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
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

function parseCookies(req: IncomingMessage): Map<string, string> {
  const map = new Map<string, string>();
  const raw = req.headers.cookie ?? "";
  for (const pair of raw.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return map;
}

function setSessionCookie(res: ServerResponse, token: string) {
  const cookie = `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`;
  res.setHeader("Set-Cookie", cookie);
}

function clearSessionCookie(res: ServerResponse) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

function getSessionToken(req: IncomingMessage): string | undefined {
  // Check cookie first, then Authorization header
  const cookies = parseCookies(req);
  const fromCookie = cookies.get(SESSION_COOKIE_NAME);
  if (fromCookie) return fromCookie;
  const authHeader = (req.headers.authorization ?? "").trim();
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }
  return undefined;
}

function isHtmlRequest(req: IncomingMessage): boolean {
  return (req.headers.accept ?? "").includes("text/html");
}

// ── Auth gate ────────────────────────────────────────────────────────────────

export type SafeAuthGateOpts = {
  needsSetup: boolean;
  sessionSecret: string;
  configPassword?: string;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
};

/**
 * Server-side auth gate.  Call this early in the HTTP pipeline.
 * Returns true if the request was handled (blocked or served login/setup page).
 * Returns false if the request is authenticated and should proceed normally.
 */
export async function handleSafeAuthGate(
  req: IncomingMessage,
  res: ServerResponse,
  opts: SafeAuthGateOpts,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;
  const method = (req.method ?? "GET").toUpperCase();
  const isLocal = isLocalDirectRequest(req, opts.trustedProxies ?? [], opts.allowRealIpFallback);

  // Health/readiness probes always pass through (monitoring, load balancers)
  if (pathname === "/health" || pathname === "/healthz" || pathname === "/ready" || pathname === "/readyz") {
    return false;
  }

  // Safe API endpoints handle their own auth
  if (pathname === SAFE_SETUP_PATH || pathname === SAFE_LOGIN_PATH ||
      pathname === SAFE_RESET_PATH || pathname === SAFE_AUTH_STATUS_PATH ||
      pathname === SAFE_SETUP_PAGE_PATH) {
    return handleSafeEndpoint(req, res, pathname, method, isLocal, opts);
  }

  // ── Setup mode: password not configured yet ──
  if (opts.needsSetup) {
    if (!isLocal) {
      sendJson(res, 403, {
        ok: false,
        error: "Gateway requires first-time setup. Open http://localhost:<port>/setup from the gateway host.",
      });
      return true;
    }
    // Local browser → redirect to /setup
    if (isHtmlRequest(req)) {
      res.statusCode = 302;
      res.setHeader("Location", "/setup");
      res.end();
      return true;
    }
    // Local non-browser → let through (CLI tools, etc.)
    return false;
  }

  // ── Password mode: check session token ──
  const token = getSessionToken(req);
  if (token && verifySessionToken(opts.sessionSecret, token)) {
    return false; // Authenticated — proceed
  }

  // Not authenticated
  if (isHtmlRequest(req)) {
    serveLoginPage(res, isLocal);
    return true;
  }
  // API request without valid session
  res.statusCode = 401;
  res.setHeader("WWW-Authenticate", "Bearer");
  sendJson(res, 401, { ok: false, error: "Authentication required" });
  return true;
}

// ── Endpoint handlers ────────────────────────────────────────────────────────

async function handleSafeEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
  isLocal: boolean,
  opts: SafeAuthGateOpts,
): Promise<boolean> {
  // GET /api/safe/auth-status — public, tells the UI what state the gateway is in
  if (pathname === SAFE_AUTH_STATUS_PATH && method === "GET") {
    const token = getSessionToken(req);
    const authenticated = !!(token && verifySessionToken(opts.sessionSecret, token));
    sendJson(res, 200, {
      ok: true,
      needsSetup: opts.needsSetup,
      authenticated,
      isLocal,
    });
    return true;
  }

  // GET /setup — serve setup page (local only)
  if (pathname === SAFE_SETUP_PAGE_PATH && method === "GET") {
    if (!isLocal) {
      sendJson(res, 403, { ok: false, error: "Setup is only accessible from localhost" });
      return true;
    }
    if (!opts.needsSetup) {
      // Already set up → redirect to login
      res.statusCode = 302;
      res.setHeader("Location", "/");
      res.end();
      return true;
    }
    serveSetupPage(res);
    return true;
  }

  // POST /api/safe/setup — first-time password setup (local only, setup mode only)
  if (pathname === SAFE_SETUP_PATH && method === "POST") {
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

  // POST /api/safe/login — password login
  if (pathname === SAFE_LOGIN_PATH && method === "POST") {
    return handleLogin(req, res, opts);
  }

  // POST /api/safe/reset-password — local only
  if (pathname === SAFE_RESET_PATH && method === "POST") {
    if (!isLocal) {
      sendJson(res, 403, { ok: false, error: "Password reset is only accessible from localhost" });
      return true;
    }
    return handleSetPassword(req, res, opts.sessionSecret, "reset");
  }

  return false;
}

async function handleLogin(
  req: IncomingMessage,
  res: ServerResponse,
  opts: SafeAuthGateOpts,
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

  if (typeof password !== "string" || !password) {
    sendJson(res, 400, { ok: false, error: "Missing password field" });
    return true;
  }

  // Verify password against config
  if (!opts.configPassword || password !== opts.configPassword) {
    sendJson(res, 401, { ok: false, error: "Invalid password" });
    return true;
  }

  const token = issueSessionToken(opts.sessionSecret);
  setSessionCookie(res, token);
  sendJson(res, 200, {
    ok: true,
    token,
    expiresIn: SESSION_TTL_SECONDS,
  });
  return true;
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

  const token = issueSessionToken(sessionSecret);
  setSessionCookie(res, token);
  sendJson(res, 200, {
    ok: true,
    mode,
    token,
    expiresIn: SESSION_TTL_SECONDS,
  });
  return true;
}

// ── Exported helper for server-http.ts session token check ───────────────────

/**
 * Extract and verify a session token from the request (cookie or Bearer).
 * Returns true if the request carries a valid session.
 */
export function hasValidSession(req: IncomingMessage, sessionSecret: string): boolean {
  const token = getSessionToken(req);
  return !!(token && verifySessionToken(sessionSecret, token));
}

// ── Login page HTML ──────────────────────────────────────────────────────────

function serveLoginPage(res: ServerResponse, isLocal: boolean) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  const resetSection = isLocal
    ? `<div id="resetSection" class="hidden">
    <hr style="border-color:#2d3148;margin:1.5rem 0">
    <h2 style="font-size:1.1rem;margin-bottom:0.5rem">Reset password</h2>
    <form id="resetForm">
      <label for="newPw">New password</label>
      <input type="password" id="newPw" autocomplete="new-password" required>
      <p class="hint">8+ characters &middot; uppercase &middot; lowercase &middot; digit</p>
      <label for="newPw2">Confirm new password</label>
      <input type="password" id="newPw2" autocomplete="new-password" required>
      <p id="resetMsg" class="error" style="display:none"></p>
      <button type="submit" id="resetSubmitBtn" class="btn-primary">Reset &amp; login</button>
    </form>
  </div>
  <button type="button" id="resetBtn" class="link-btn" onclick="showReset()">Reset password</button>`
    : "";
  res.end(LOGIN_PAGE_HTML.replace("<!--RESET_SECTION-->", resetSection));
}

function serveSetupPage(res: ServerResponse) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(SETUP_PAGE_HTML);
}

// ── HTML templates ───────────────────────────────────────────────────────────

const SHARED_STYLES = `
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
    box-shadow: 0 4px 24px rgba(0,0,0,0.3);
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
  .btn-primary {
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
  .btn-primary:hover { background: #4f46e5; }
  .btn-primary:disabled { background: #374151; cursor: not-allowed; }
  .error { color: #f87171; font-size: 0.875rem; margin-bottom: 1rem; }
  .success { color: #4ade80; font-size: 0.875rem; margin-bottom: 1rem; }
  .link-btn {
    background: none;
    border: none;
    color: #64748b;
    font-size: 0.8rem;
    cursor: pointer;
    margin-top: 1rem;
    text-decoration: underline;
    padding: 0;
  }
  .link-btn:hover { color: #94a3b8; }
  .hidden { display: none; }
`;

const LOGIN_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>safe-openclaw — Login</title>
<style>${SHARED_STYLES}</style>
</head>
<body>
<div class="card">
  <h1>safe-openclaw</h1>
  <p class="subtitle">Enter your gateway password to continue.</p>

  <!-- Login form -->
  <form id="loginForm">
    <label for="pw">Password</label>
    <input type="password" id="pw" name="password" autocomplete="current-password" required autofocus>
    <p id="loginMsg" class="error" style="display:none"></p>
    <button type="submit" id="loginBtn" class="btn-primary">Login</button>
  </form>

  <!--RESET_SECTION-->
</div>
<script>
  // Login
  const loginForm = document.getElementById('loginForm');
  const pw = document.getElementById('pw');
  const loginMsg = document.getElementById('loginMsg');
  const loginBtn = document.getElementById('loginBtn');

  function showMsg(el, text, type) {
    el.textContent = text;
    el.className = type;
    el.style.display = '';
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginMsg.style.display = 'none';
    loginBtn.disabled = true;
    loginBtn.textContent = 'Logging in…';
    try {
      const res = await fetch('/api/safe/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw.value }),
      });
      const data = await res.json();
      if (!data.ok) {
        showMsg(loginMsg, data.error || 'Login failed', 'error');
        loginBtn.disabled = false;
        loginBtn.textContent = 'Login';
        return;
      }
      // Cookie is set by server; also store token for WebSocket auth
      if (data.token) {
        localStorage.setItem('openclaw_token', data.token);
      }
      window.location.reload();
    } catch (err) {
      showMsg(loginMsg, 'Network error: ' + err, 'error');
      loginBtn.disabled = false;
      loginBtn.textContent = 'Login';
    }
  });

  // Password reset (local only)
  function showReset() {
    document.getElementById('resetSection').classList.remove('hidden');
    const btn = document.getElementById('resetBtn');
    if (btn) btn.style.display = 'none';
  }

  const resetForm = document.getElementById('resetForm');
  if (resetForm) {
    const newPw = document.getElementById('newPw');
    const newPw2 = document.getElementById('newPw2');
    const resetMsg = document.getElementById('resetMsg');
    const resetSubmitBtn = document.getElementById('resetSubmitBtn');

    resetForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      resetMsg.style.display = 'none';
      if (newPw.value !== newPw2.value) {
        showMsg(resetMsg, 'Passwords do not match.', 'error');
        return;
      }
      resetSubmitBtn.disabled = true;
      resetSubmitBtn.textContent = 'Saving…';
      try {
        const res = await fetch('/api/safe/reset-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: newPw.value }),
        });
        const data = await res.json();
        if (!data.ok) {
          showMsg(resetMsg, data.error || 'Reset failed', 'error');
          resetSubmitBtn.disabled = false;
          resetSubmitBtn.textContent = 'Reset & login';
          return;
        }
        if (data.token) {
          localStorage.setItem('openclaw_token', data.token);
        }
        showMsg(resetMsg, 'Password reset! Redirecting…', 'success');
        setTimeout(() => { window.location.href = '/'; }, 800);
      } catch (err) {
        showMsg(resetMsg, 'Network error: ' + err, 'error');
        resetSubmitBtn.disabled = false;
        resetSubmitBtn.textContent = 'Reset & login';
      }
    });
  }
</script>
</body>
</html>
`;

const SETUP_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>safe-openclaw — Setup</title>
<style>${SHARED_STYLES}</style>
</head>
<body>
<div class="card">
  <h1>safe-openclaw</h1>
  <p class="subtitle">Set a password to secure your gateway before going further.</p>
  <form id="form">
    <label for="pw">Password</label>
    <input type="password" id="pw" name="password" autocomplete="new-password" required autofocus>
    <p class="hint">8+ characters &middot; uppercase &middot; lowercase &middot; digit</p>
    <label for="pw2">Confirm password</label>
    <input type="password" id="pw2" name="password2" autocomplete="new-password" required>
    <p id="msg" class="error" style="display:none"></p>
    <button type="submit" id="btn" class="btn-primary">Set password &amp; continue</button>
  </form>
</div>
<script>
  const form = document.getElementById('form');
  const pw = document.getElementById('pw');
  const pw2 = document.getElementById('pw2');
  const msg = document.getElementById('msg');
  const btn = document.getElementById('btn');

  function showMsg(text, type) {
    msg.textContent = text;
    msg.className = type;
    msg.style.display = '';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.style.display = 'none';
    if (pw.value !== pw2.value) {
      showMsg('Passwords do not match.', 'error');
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
        showMsg(data.error || 'Unknown error', 'error');
        btn.disabled = false;
        btn.textContent = 'Set password & continue';
        return;
      }
      if (data.token) {
        localStorage.setItem('openclaw_token', data.token);
      }
      showMsg('Password set! Redirecting…', 'success');
      setTimeout(() => { window.location.href = '/'; }, 800);
    } catch (err) {
      showMsg('Network error: ' + err, 'error');
      btn.disabled = false;
      btn.textContent = 'Set password & continue';
    }
  });
</script>
</body>
</html>
`;
