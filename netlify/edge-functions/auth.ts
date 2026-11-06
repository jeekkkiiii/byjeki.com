// Protects the whole site. Runs on Netlify's edge before any page is served.
//
// Environment variables (Netlify → Site configuration → Environment variables):
//
//   Username / password login
//     SITE_USERNAME         – required
//     SITE_PASSWORD         – required
//     SESSION_SECRET        – recommended; signs session cookies (changing it logs everyone out)
//
//   Google sign-in (optional – the button only appears when both IDs are set)
//     GOOGLE_CLIENT_ID      – OAuth client ID from Google Cloud Console
//     GOOGLE_CLIENT_SECRET  – OAuth client secret
//     ALLOWED_EMAILS        – who may sign in with Google, comma separated, e.g.
//                             "me@gmail.com, recruiter@company.com, @company.com"
//                             An entry starting with "@" allows a whole domain; "*" allows anyone.
//                             If unset, nobody can get in with Google.

import type { Config, Context } from "@netlify/edge-functions";

const COOKIE = "byjeki_session";
const OAUTH_COOKIE = "byjeki_oauth";
const SESSION_DAYS = 7;
const PUBLIC_PATHS = new Set(["/login", "/login.html", "/favicon.ico", "/robots.txt"]);
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const enc = new TextEncoder();
const dec = new TextDecoder();

// ─── helpers ───────────────────────────────────────────────────────────────

function env(name: string): string | undefined {
  return Netlify.env.get(name)?.trim() || undefined;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Uint8Array {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function randomString(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
}

async function sha256(data: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(data))));
}

// Constant-time string comparison (compares HMACs so lengths always match).
async function safeEqual(a: string, b: string, secret: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([hmac(secret, a), hmac(secret, b)]);
  let diff = ha.length ^ hb.length;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

function cookie(name: string, value: string, maxAge: number, path = "/"): string {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function safeNext(value: unknown): string {
  const next = typeof value === "string" ? value : "/";
  // Only allow same-site relative paths to avoid open redirects.
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  if (PUBLIC_PATHS.has(next.split("?")[0]) || next.startsWith("/auth/")) return "/";
  return next;
}

function redirect(location: string, ...cookies: string[]): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 303, headers });
}

function loginError(code: string, next = "/"): Response {
  return redirect(`/login?error=${code}&next=${encodeURIComponent(next)}`, cookie(OAUTH_COOKIE, "", 0));
}

// ─── sessions ──────────────────────────────────────────────────────────────
// Token format: <expiry>.<subject>.<signature>
//   subject "pw" = username/password login, otherwise base64url(email) for Google logins.

async function makeToken(secret: string, subject: string): Promise<string> {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  return `${exp}.${subject}.${await hmac(secret, `session.${exp}.${subject}`)}`;
}

async function readToken(token: string | undefined, secret: string): Promise<string | null> {
  if (!token) return null;
  const [expStr, subject, sig, extra] = token.split(".");
  const exp = Number(expStr);
  if (!subject || !sig || extra !== undefined || !Number.isFinite(exp) || exp < Date.now()) return null;
  if (!(await safeEqual(sig, await hmac(secret, `session.${exp}.${subject}`), secret))) return null;
  return subject;
}

// ─── Google ────────────────────────────────────────────────────────────────

function googleConfig() {
  const id = env("GOOGLE_CLIENT_ID");
  const secret = env("GOOGLE_CLIENT_SECRET");
  return id && secret ? { id, secret } : null;
}

function emailAllowed(email: string): boolean {
  const list = (env("ALLOWED_EMAILS") ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const e = email.toLowerCase();
  return list.some((entry) => entry === "*" || entry === e || (entry.startsWith("@") && e.endsWith(entry)));
}

async function googleStart(url: URL, secret: string, clientId: string): Promise<Response> {
  const state = randomString();
  const verifier = randomString(48);
  const next = safeNext(url.searchParams.get("next"));
  const payload = b64url(enc.encode(JSON.stringify({ state, verifier, next, exp: Date.now() + 10 * 60e3 })));
  const signed = `${payload}.${await hmac(secret, `oauth.${payload}`)}`;

  const auth = new URL(GOOGLE_AUTH_URL);
  auth.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${url.origin}/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: await sha256(verifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();

  return redirect(auth.toString(), cookie(OAUTH_COOKIE, signed, 600, "/auth/"));
}

async function googleCallback(url: URL, context: Context, secret: string, google: { id: string; secret: string }) {
  // Validate the short-lived cookie set by googleStart
  const raw = context.cookies.get(OAUTH_COOKIE) ?? "";
  const [payload, sig] = raw.split(".");
  if (!payload || !sig || !(await safeEqual(sig, await hmac(secret, `oauth.${payload}`), secret))) {
    return loginError("google");
  }
  let saved: { state: string; verifier: string; next: string; exp: number };
  try {
    saved = JSON.parse(dec.decode(b64urlDecode(payload)));
  } catch {
    return loginError("google");
  }
  const next = safeNext(saved.next);

  if (url.searchParams.get("error")) return loginError("google_cancelled", next);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") ?? "";
  if (!code || saved.exp < Date.now() || !(await safeEqual(state, saved.state, secret))) {
    return loginError("google", next);
  }

  // Exchange the code for tokens (server-to-server, over TLS, directly with Google)
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: google.id,
      client_secret: google.secret,
      redirect_uri: `${url.origin}/auth/google/callback`,
      grant_type: "authorization_code",
      code_verifier: saved.verifier,
    }),
  });
  if (!res.ok) {
    console.error("Google token exchange failed", res.status, await res.text());
    return loginError("google", next);
  }
  const { id_token } = await res.json();

  // The ID token came straight from Google's token endpoint over TLS, so per the
  // OpenID Connect spec we can trust its contents after checking the claims.
  let claims: { iss?: string; aud?: string; exp?: number; email?: string; email_verified?: boolean };
  try {
    claims = JSON.parse(dec.decode(b64urlDecode(String(id_token).split(".")[1])));
  } catch {
    return loginError("google", next);
  }
  const issOk = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
  if (!issOk || claims.aud !== google.id || !claims.exp || claims.exp * 1000 < Date.now()) {
    return loginError("google", next);
  }
  if (!claims.email || !claims.email_verified || !emailAllowed(claims.email)) {
    return loginError("google_denied", next);
  }

  const token = await makeToken(secret, b64url(enc.encode(claims.email.toLowerCase())));
  return redirect(next, cookie(COOKIE, token, SESSION_DAYS * 86400), cookie(OAUTH_COOKIE, "", 0, "/auth/"));
}

// Serves login.html, removing the Google button when Google isn't configured.
async function serveLoginPage(request: Request, context: Context, googleEnabled: boolean): Promise<Response | URL> {
  if (googleEnabled) return new URL("/login.html", request.url);
  const res = await context.next();
  const html = (await res.text()).replace(/<!--google-start-->[\s\S]*?<!--google-end-->/, "");
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(html, { status: res.status, headers });
}

// ─── handler ───────────────────────────────────────────────────────────────

export default async function handler(request: Request, context: Context) {
  const url = new URL(request.url);
  const path = url.pathname;

  const username = env("SITE_USERNAME");
  const password = env("SITE_PASSWORD");
  if (!username || !password) {
    return new Response(
      "Site login is not configured. Set SITE_USERNAME and SITE_PASSWORD in Netlify environment variables.",
      { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } },
    );
  }

  const secret = env("SESSION_SECRET") ?? `byjeki:${password}`;
  const google = googleConfig();

  const subject = await readToken(context.cookies.get(COOKIE), secret);
  // Google sessions are re-checked against the allowlist, so removing an email revokes access.
  const authed =
    subject === "pw" ||
    (subject !== null && google !== null && emailAllowed(dec.decode(b64urlDecode(subject))));

  // Log out
  if (path === "/logout") {
    return redirect("/login", cookie(COOKIE, "", 0));
  }

  // Google sign-in
  if (path === "/auth/google" || path === "/auth/google/callback") {
    if (!google) return loginError("google_off");
    return path === "/auth/google"
      ? googleStart(url, secret, google.id)
      : googleCallback(url, context, secret, google);
  }

  // Username / password form submission
  if ((path === "/login" || path === "/login.html") && request.method === "POST") {
    const form = await request.formData().catch(() => null);
    const user = String(form?.get("username") ?? "");
    const pass = String(form?.get("password") ?? "");
    const next = safeNext(form?.get("next"));

    const userOk = await safeEqual(user, username, secret);
    const passOk = await safeEqual(pass, password, secret);
    if (!(userOk && passOk)) {
      await new Promise((r) => setTimeout(r, 600)); // slow down guessing
      return redirect(`/login?error=1&next=${encodeURIComponent(next)}`);
    }

    return redirect(next, cookie(COOKIE, await makeToken(secret, "pw"), SESSION_DAYS * 86400));
  }

  // Login page itself is public (but skip it if already logged in)
  if (PUBLIC_PATHS.has(path)) {
    if (path === "/login" || path === "/login.html") {
      if (authed) return redirect(safeNext(url.searchParams.get("next")));
      return serveLoginPage(request, context, google !== null);
    }
    return context.next();
  }

  // Everything else requires a valid session
  if (!authed) {
    return redirect(`/login?next=${encodeURIComponent(path + url.search)}`);
  }

  const response = await context.next();
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config: Config = {
  path: "/*",
};
