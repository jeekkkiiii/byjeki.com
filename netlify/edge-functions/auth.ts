// Password-protects the whole site. Runs on Netlify's edge before any page is served.
//
// Required environment variables (Netlify → Site configuration → Environment variables):
//   SITE_USERNAME   – the username to log in with
//   SITE_PASSWORD   – the password to log in with
// Optional:
//   SESSION_SECRET  – long random string used to sign session cookies.
//                     Changing it logs everyone out. Defaults to a value derived from the password.

import type { Config, Context } from "@netlify/edge-functions";

const COOKIE = "byjeki_session";
const SESSION_DAYS = 7;
const PUBLIC_PATHS = new Set(["/login", "/login.html", "/favicon.ico", "/robots.txt"]);

const enc = new TextEncoder();

function env(name: string): string | undefined {
  return Netlify.env.get(name) || undefined;
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Constant-time string comparison (compares HMACs so lengths always match).
async function safeEqual(a: string, b: string, secret: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([hmac(secret, a), hmac(secret, b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0 && ha.length === hb.length;
}

function sessionSecret(password: string): string {
  return env("SESSION_SECRET") ?? `byjeki:${password}`;
}

async function makeToken(secret: string): Promise<string> {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  return `${exp}.${await hmac(secret, `session.${exp}`)}`;
}

async function validToken(token: string | undefined, secret: string): Promise<boolean> {
  if (!token) return false;
  const [expStr, sig] = token.split(".");
  const exp = Number(expStr);
  if (!sig || !Number.isFinite(exp) || exp < Date.now()) return false;
  return safeEqual(sig, await hmac(secret, `session.${exp}`), secret);
}

function safeNext(value: unknown): string {
  const next = typeof value === "string" ? value : "/";
  // Only allow same-site relative paths to avoid open redirects.
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  if (PUBLIC_PATHS.has(next.split("?")[0])) return "/";
  return next;
}

function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

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

  const secret = sessionSecret(password);
  const authed = await validToken(context.cookies.get(COOKIE), secret);

  // Log out
  if (path === "/logout") {
    return redirect("/login", `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  }

  // Handle login form submission
  if ((path === "/login" || path === "/login.html") && request.method === "POST") {
    const form = await request.formData().catch(() => null);
    const user = String(form?.get("username") ?? "");
    const pass = String(form?.get("password") ?? "");
    const next = safeNext(form?.get("next"));

    const ok = (await safeEqual(user, username, secret)) & Number(await safeEqual(pass, password, secret));
    if (!ok) {
      await new Promise((r) => setTimeout(r, 600)); // slow down guessing
      return redirect(`/login?error=1&next=${encodeURIComponent(next)}`);
    }

    const token = await makeToken(secret);
    return redirect(next, `${COOKIE}=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`);
  }

  // Login page itself is public (but skip it if already logged in)
  if (PUBLIC_PATHS.has(path)) {
    if (authed && (path === "/login" || path === "/login.html")) {
      return redirect(safeNext(url.searchParams.get("next")));
    }
    if (path === "/login") return new URL("/login.html", request.url);
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
