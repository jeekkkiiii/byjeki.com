// Reads the signed login cookie created by netlify/edge-functions/auth.ts and returns who
// is logged in. Must stay in step with auth.ts (cookie name, token format and secret).
//
// Token format: <expiry>.<subject>.<signature>
//   subject "pw" = username/password login (the site owner)
//   otherwise base64url(email) for Google logins

const COOKIE = "byjeki_session";
const enc = new TextEncoder();
const dec = new TextDecoder();

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

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
}

async function safeEqual(a: string, b: string, secret: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([hmac(secret, a), hmac(secret, b)]);
  let diff = ha.length ^ hb.length;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

export type SessionUser = {
  /** Stable, non-reversible id used to namespace this person's stored data. */
  key: string;
  /** "owner" for the username/password login, otherwise the Google email. */
  label: string;
};

export async function sessionUser(cookieValue: string | undefined): Promise<SessionUser | null> {
  const password = env("SITE_PASSWORD");
  if (!password || !cookieValue) return null;
  const secret = env("SESSION_SECRET") ?? `byjeki:${password}`;

  const [expStr, subject, sig, extra] = cookieValue.split(".");
  const exp = Number(expStr);
  if (!subject || !sig || extra !== undefined || !Number.isFinite(exp) || exp < Date.now()) return null;
  if (!(await safeEqual(sig, await hmac(secret, `session.${exp}.${subject}`), secret))) return null;

  const label = subject === "pw" ? "owner" : dec.decode(b64urlDecode(subject)).toLowerCase();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`user:${label}`)));
  const key = Array.from(digest.slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
  return { key, label };
}

export { COOKIE as SESSION_COOKIE };
