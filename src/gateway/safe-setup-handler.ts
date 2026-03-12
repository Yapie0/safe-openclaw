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
import { hashPassword, verifyPassword, getPasswordHashHex, encryptEnvValues } from "./safe-crypto.js";
import { validateStrongPassword } from "./safe-password-policy.js";
import { issueSessionToken, verifySessionToken } from "./safe-session.js";

const SAFE_SETUP_PATH = "/api/safe/setup";
const SAFE_LOGIN_PATH = "/api/safe/login";
const SAFE_LOGOUT_PATH = "/api/safe/logout";
const SAFE_RESET_PATH = "/api/safe/reset-password";
const SAFE_AUTH_STATUS_PATH = "/api/safe/auth-status";
const SAFE_SETUP_PAGE_PATH = "/setup";
const SAFE_RESET_PAGE_PATH = "/reset-password";
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
      pathname === SAFE_LOGOUT_PATH || pathname === SAFE_RESET_PATH ||
      pathname === SAFE_AUTH_STATUS_PATH || pathname === SAFE_SETUP_PAGE_PATH ||
      pathname === SAFE_RESET_PAGE_PATH) {
    return handleSafeEndpoint(req, res, pathname, method, isLocal, opts);
  }

  // ── Check session token (applies to both setup and normal mode) ──
  const token = getSessionToken(req);
  if (token && verifySessionToken(opts.sessionSecret, token)) {
    return false; // Authenticated — proceed
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

  // POST /api/safe/logout — clear session cookie
  if (pathname === SAFE_LOGOUT_PATH && method === "POST") {
    clearSessionCookie(res);
    console.log("[safe-openclaw] user logged out");
    sendJson(res, 200, { ok: true });
    return true;
  }

  // GET /reset-password — serve reset password page (local only)
  if (pathname === SAFE_RESET_PAGE_PATH && method === "GET") {
    if (!isLocal) {
      sendJson(res, 403, { ok: false, error: "Password reset is only accessible from localhost" });
      return true;
    }
    serveResetPasswordPage(res);
    return true;
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

  // Verify password against config (read fresh in case it was reset)
  const currentPassword = opts.configPassword || loadConfig().gateway?.auth?.password;
  if (!currentPassword || !verifyPassword(password, currentPassword)) {
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

  // Hash password and encrypt env values before persisting
  const passwordHashed = hashPassword(password);
  const newKeyHex = getPasswordHashHex(passwordHashed);

  try {
    const cfg: OpenClawConfig = loadConfig();

    // Determine old key for re-encryption (reset case: old password hash is in config)
    const oldStoredPassword = cfg.gateway?.auth?.password;
    const oldKeyHex = oldStoredPassword ? getPasswordHashHex(oldStoredPassword) : undefined;

    // Encrypt env values (string entries only; nested objects like shellEnv are skipped)
    const encryptedEnv = cfg.env
      ? encryptEnvValues(cfg.env as Record<string, unknown>, newKeyHex, oldKeyHex)
      : undefined;

    const nextCfg: OpenClawConfig = {
      ...cfg,
      env: encryptedEnv ?? cfg.env,
      gateway: {
        ...cfg.gateway,
        auth: {
          ...cfg.gateway?.auth,
          mode: "password",
          token: undefined,
          password: passwordHashed,
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
  const resetLink = isLocal
    ? `<a href="/reset-password" class="link-btn">Reset password</a>`
    : "";
  res.end(LOGIN_PAGE_HTML.replace("<!--RESET_LINK-->", resetLink));
}

function serveResetPasswordPage(res: ServerResponse) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(RESET_PASSWORD_PAGE_HTML);
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
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background: #0c0a1a;
    color: #e2e8f0;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 1rem;
    overflow: hidden;
    position: relative;
  }
  body::before {
    content: '';
    position: fixed;
    top: -40%;
    left: -20%;
    width: 80%;
    height: 80%;
    background: radial-gradient(ellipse, rgba(124,58,237,0.15) 0%, transparent 70%);
    pointer-events: none;
    animation: glow-drift 8s ease-in-out infinite alternate;
  }
  body::after {
    content: '';
    position: fixed;
    bottom: -30%;
    right: -20%;
    width: 70%;
    height: 70%;
    background: radial-gradient(ellipse, rgba(236,72,153,0.1) 0%, transparent 70%);
    pointer-events: none;
    animation: glow-drift 10s ease-in-out infinite alternate-reverse;
  }
  @keyframes glow-drift {
    0% { transform: translate(0, 0) scale(1); }
    100% { transform: translate(30px, -20px) scale(1.05); }
  }
  .card {
    position: relative;
    background: rgba(20, 16, 40, 0.7);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border: 1px solid rgba(124, 58, 237, 0.2);
    border-radius: 20px;
    padding: 2.5rem;
    width: 100%;
    max-width: 420px;
    box-shadow:
      0 8px 32px rgba(0, 0, 0, 0.4),
      0 0 0 1px rgba(124, 58, 237, 0.05) inset,
      0 0 80px -20px rgba(124, 58, 237, 0.1);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 0.25rem;
  }
  .brand-icon {
    width: 32px;
    height: 32px;
    background: linear-gradient(135deg, #7c3aed, #ec4899);
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .brand-icon svg {
    width: 18px;
    height: 18px;
    stroke: #fff;
    fill: none;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  h1 {
    font-size: 1.35rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    background: linear-gradient(135deg, #e2e8f0 30%, #a78bfa);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }
  .subtitle {
    color: rgba(148, 163, 184, 0.8);
    font-size: 0.875rem;
    margin-bottom: 1.75rem;
    line-height: 1.5;
  }
  label {
    display: block;
    font-size: 0.8rem;
    font-weight: 500;
    margin-bottom: 0.4rem;
    color: rgba(203, 213, 225, 0.9);
    letter-spacing: 0.02em;
  }
  input[type=password] {
    width: 100%;
    padding: 0.7rem 0.85rem;
    background: rgba(15, 10, 30, 0.6);
    border: 1px solid rgba(124, 58, 237, 0.2);
    border-radius: 10px;
    color: #e2e8f0;
    font-size: 0.95rem;
    margin-bottom: 1rem;
    outline: none;
    transition: border-color 0.2s, box-shadow 0.2s;
  }
  input[type=password]:focus {
    border-color: rgba(124, 58, 237, 0.5);
    box-shadow: 0 0 0 3px rgba(124, 58, 237, 0.1), 0 0 20px -5px rgba(124, 58, 237, 0.2);
  }
  input[type=password]::placeholder { color: rgba(100, 116, 139, 0.6); }
  .hint {
    font-size: 0.75rem;
    color: rgba(100, 116, 139, 0.7);
    margin-top: -0.7rem;
    margin-bottom: 1rem;
  }
  .btn-primary {
    width: 100%;
    padding: 0.7rem;
    background: linear-gradient(135deg, #7c3aed, #6d28d9);
    color: #fff;
    border: none;
    border-radius: 10px;
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
    box-shadow: 0 4px 15px -3px rgba(124, 58, 237, 0.4);
    letter-spacing: 0.01em;
  }
  .btn-primary:hover {
    background: linear-gradient(135deg, #8b5cf6, #7c3aed);
    box-shadow: 0 6px 20px -3px rgba(124, 58, 237, 0.5);
    transform: translateY(-1px);
  }
  .btn-primary:active { transform: translateY(0); }
  .btn-primary:disabled {
    background: rgba(55, 65, 81, 0.5);
    box-shadow: none;
    cursor: not-allowed;
    transform: none;
  }
  .error {
    color: #f87171;
    font-size: 0.85rem;
    margin-bottom: 1rem;
    padding: 0.5rem 0.75rem;
    background: rgba(248, 113, 113, 0.08);
    border-radius: 8px;
    border: 1px solid rgba(248, 113, 113, 0.15);
  }
  .success {
    color: #4ade80;
    font-size: 0.85rem;
    margin-bottom: 1rem;
    padding: 0.5rem 0.75rem;
    background: rgba(74, 222, 128, 0.08);
    border-radius: 8px;
    border: 1px solid rgba(74, 222, 128, 0.15);
  }
  .link-btn {
    display: inline-block;
    background: none;
    border: none;
    color: rgba(139, 92, 246, 0.7);
    font-size: 0.8rem;
    cursor: pointer;
    margin-top: 1.25rem;
    text-decoration: none;
    padding: 0;
    transition: color 0.15s;
  }
  .link-btn:hover { color: #a78bfa; }
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
  <div class="brand">
    <div class="brand-icon"><svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg></div>
    <h1>safe-openclaw</h1>
  </div>
  <p class="subtitle">Enter your gateway password to continue.</p>
  <form id="loginForm">
    <label for="pw">Password</label>
    <input type="password" id="pw" name="password" autocomplete="current-password" required autofocus placeholder="Enter password">
    <p id="loginMsg" class="error" style="display:none"></p>
    <button type="submit" id="loginBtn" class="btn-primary">Login</button>
  </form>
  <!--RESET_LINK-->
</div>
<script>
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
      if (data.token) localStorage.setItem('openclaw_token', data.token);
      window.location.reload();
    } catch (err) {
      showMsg(loginMsg, 'Network error: ' + err, 'error');
      loginBtn.disabled = false;
      loginBtn.textContent = 'Login';
    }
  });
</script>
</body>
</html>
`;

const RESET_PASSWORD_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>safe-openclaw — Reset Password</title>
<style>${SHARED_STYLES}</style>
</head>
<body>
<div class="card">
  <div class="brand">
    <div class="brand-icon"><svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg></div>
    <h1>safe-openclaw</h1>
  </div>
  <p class="subtitle">Set a new password for your gateway.</p>
  <form id="resetForm">
    <label for="newPw">New password</label>
    <input type="password" id="newPw" autocomplete="new-password" required autofocus>
    <p class="hint">8+ characters &middot; uppercase &middot; lowercase &middot; digit</p>
    <label for="newPw2">Confirm new password</label>
    <input type="password" id="newPw2" autocomplete="new-password" required>
    <button type="submit" id="resetSubmitBtn" class="btn-primary">Reset &amp; login</button>
  </form>
  <p id="resetMsg" class="error" style="display:none"></p>
  <a href="/" class="link-btn">Back to login</a>
</div>
<script>
  const resetForm = document.getElementById('resetForm');
  const newPw = document.getElementById('newPw');
  const newPw2 = document.getElementById('newPw2');
  const resetMsg = document.getElementById('resetMsg');
  const resetSubmitBtn = document.getElementById('resetSubmitBtn');
  function showMsg(el, text, type) {
    el.textContent = text;
    el.className = type;
    el.style.display = '';
  }
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
      if (data.token) localStorage.setItem('openclaw_token', data.token);
      resetForm.style.display = 'none';
      document.querySelector('.link-btn').style.display = 'none';
      resetMsg.innerHTML = '<strong>Password reset successful!</strong><br><br>' +
        'The gateway will restart automatically to apply the new encryption keys.<br><br>' +
        'If it does not restart, run:<br>' +
        '<code style="display:block;margin-top:0.5rem;padding:0.5rem 0.75rem;background:rgba(15,10,30,0.6);border-radius:6px;font-size:0.85rem;color:#a78bfa;">openclaw gateway stop && openclaw gateway run</code>' +
        '<button id="checkRestartBtn" class="btn-primary" style="margin-top:1.25rem;" onclick="checkRestart()">Verify &amp; continue</button>' +
        '<p id="restartStatus" style="margin-top:0.75rem;font-size:0.85rem;color:rgba(148,163,184,0.8);display:none;"></p>';
      resetMsg.className = 'success';
      resetMsg.style.display = '';
    } catch (err) {
      showMsg(resetMsg, 'Network error: ' + err, 'error');
      resetSubmitBtn.disabled = false;
      resetSubmitBtn.textContent = 'Reset & login';
    }
  });

  let restartCheckInterval = null;
  window.checkRestart = function() {
    const btn = document.getElementById('checkRestartBtn');
    const status = document.getElementById('restartStatus');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    status.style.display = '';
    status.style.color = 'rgba(148,163,184,0.8)';
    status.textContent = 'Waiting for gateway to shut down…';
    let attempts = 0;
    const maxAttempts = 40;
    let sawDown = false;
    if (restartCheckInterval) clearInterval(restartCheckInterval);
    restartCheckInterval = setInterval(async () => {
      attempts++;
      try {
        const r = await fetch('/api/safe/auth-status', { signal: AbortSignal.timeout(3000) });
        if (r.ok && sawDown) {
          clearInterval(restartCheckInterval);
          status.style.color = '#4ade80';
          status.textContent = 'Gateway is running! Redirecting…';
          btn.textContent = 'OK';
          setTimeout(() => { window.location.href = '/'; }, 1000);
          return;
        }
      } catch {
        sawDown = true;
      }
      if (attempts >= maxAttempts) {
        clearInterval(restartCheckInterval);
        status.style.color = '#f87171';
        status.textContent = 'Gateway did not respond. Please restart manually.';
        btn.disabled = false;
        btn.textContent = 'Retry';
      } else if (!sawDown) {
        status.textContent = 'Waiting for gateway to shut down… (' + attempts + '/' + maxAttempts + ')';
      } else {
        status.textContent = 'Gateway stopped. Waiting for restart… (' + attempts + '/' + maxAttempts + ')';
      }
    }, 2000);
  };
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
  <div class="brand">
    <div class="brand-icon"><svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg></div>
    <h1>safe-openclaw</h1>
  </div>
  <p class="subtitle">Set a password to secure your gateway before going further.</p>
  <form id="form">
    <label for="pw">Password</label>
    <input type="password" id="pw" name="password" autocomplete="new-password" required autofocus>
    <p class="hint">8+ characters &middot; uppercase &middot; lowercase &middot; digit</p>
    <label for="pw2">Confirm password</label>
    <input type="password" id="pw2" name="password2" autocomplete="new-password" required>
    <button type="submit" id="btn" class="btn-primary">Set password &amp; continue</button>
  </form>
  <p id="msg" class="error" style="display:none"></p>
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
      form.style.display = 'none';
      msg.innerHTML = '<strong>Password set! Encrypting your API tokens…</strong><br><br>' +
        'The gateway will restart automatically to apply encryption.<br><br>' +
        'If it does not restart, run:<br>' +
        '<code style="display:block;margin-top:0.5rem;padding:0.5rem 0.75rem;background:rgba(15,10,30,0.6);border-radius:6px;font-size:0.85rem;color:#a78bfa;">openclaw gateway stop && openclaw gateway run</code>' +
        '<button id="checkRestartBtn" class="btn-primary" style="margin-top:1.25rem;" onclick="checkRestart()">Verify &amp; continue</button>' +
        '<p id="restartStatus" style="margin-top:0.75rem;font-size:0.85rem;color:rgba(148,163,184,0.8);display:none;"></p>';
      msg.className = 'success';
      msg.style.display = '';
    } catch (err) {
      showMsg('Network error: ' + err, 'error');
      btn.disabled = false;
      btn.textContent = 'Set password & continue';
    }
  });

  let restartCheckInterval = null;
  window.checkRestart = function() {
    const btn = document.getElementById('checkRestartBtn');
    const status = document.getElementById('restartStatus');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    status.style.display = '';
    status.style.color = 'rgba(148,163,184,0.8)';
    status.textContent = 'Waiting for gateway to shut down…';
    let attempts = 0;
    const maxAttempts = 40;
    let sawDown = false;
    if (restartCheckInterval) clearInterval(restartCheckInterval);
    restartCheckInterval = setInterval(async () => {
      attempts++;
      try {
        const r = await fetch('/api/safe/auth-status', { signal: AbortSignal.timeout(3000) });
        if (r.ok && sawDown) {
          clearInterval(restartCheckInterval);
          status.style.color = '#4ade80';
          status.textContent = 'Gateway is running! Redirecting…';
          btn.textContent = 'OK';
          setTimeout(() => { window.location.href = '/'; }, 1000);
          return;
        }
      } catch {
        sawDown = true;
      }
      if (attempts >= maxAttempts) {
        clearInterval(restartCheckInterval);
        status.style.color = '#f87171';
        status.textContent = 'Gateway did not respond. Please restart manually.';
        btn.disabled = false;
        btn.textContent = 'Retry';
      } else if (!sawDown) {
        status.textContent = 'Waiting for gateway to shut down… (' + attempts + '/' + maxAttempts + ')';
      } else {
        status.textContent = 'Gateway stopped. Waiting for restart… (' + attempts + '/' + maxAttempts + ')';
      }
    }, 2000);
  };
</script>
</body>
</html>
`;
