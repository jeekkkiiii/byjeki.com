// AI chat backend: forwards the conversation to an Ollama server and streams the reply back.
// Runs after the "auth" edge function (see netlify.toml), so only logged-in visitors reach it.
//
// Environment variables (Netlify → Site configuration → Environment variables):
//   OLLAMA_API_KEY   – API key from ollama.com (Ollama Cloud). Required for Ollama Cloud.
//   OLLAMA_HOST      – optional; defaults to https://ollama.com. Set this to your own server
//                      (e.g. a Cloudflare Tunnel URL to Ollama on your PC) to self-host.
//   OLLAMA_MODEL     – optional; defaults to gpt-oss:120b.
//   CHAT_SYSTEM_PROMPT – optional; instructions/personality for the assistant.
//
// GET  /api/chat → { configured, model }   (used by the page to show status)
// POST /api/chat → body { messages: [{ role: "user" | "assistant", content: string }] }
//                  streams newline-delimited JSON straight from Ollama's /api/chat.

import type { Context } from "@netlify/edge-functions";

const MAX_MESSAGES = 40;
const MAX_CHARS_PER_MESSAGE = 8000;
const MAX_TOTAL_CHARS = 48000;
const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful, friendly AI assistant on Jeki's personal portfolio website (byjeki.com). " +
  "Answer clearly and concisely. Use Markdown for formatting, including fenced code blocks for code.";

function env(name: string): string | undefined {
  return Netlify.env.get(name)?.trim() || undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function settings() {
  const apiKey = env("OLLAMA_API_KEY");
  const host = (env("OLLAMA_HOST") ?? (apiKey ? "https://ollama.com" : "")).replace(/\/+$/, "");
  const model = env("OLLAMA_MODEL") ?? "gpt-oss:120b";
  return { apiKey, host, model, configured: host !== "" };
}

type Msg = { role: "user" | "assistant"; content: string };

function cleanMessages(input: unknown): Msg[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const msgs: Msg[] = [];
  for (const m of input.slice(-MAX_MESSAGES)) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") return null;
    msgs.push({ role: m.role, content: m.content.slice(0, MAX_CHARS_PER_MESSAGE) });
  }
  // Drop the oldest messages until we're under the total size budget.
  let total = msgs.reduce((n, m) => n + m.content.length, 0);
  while (total > MAX_TOTAL_CHARS && msgs.length > 1) total -= msgs.shift()!.content.length;
  if (msgs[msgs.length - 1].role !== "user") return null;
  return msgs;
}

export default async function handler(request: Request, _context: Context) {
  const s = settings();

  if (request.method === "GET") {
    return json({ configured: s.configured, model: s.configured ? s.model : null });
  }
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }
  if (!s.configured) {
    return json({ error: "not_configured", message: "The AI isn't connected yet." }, 503);
  }

  const body = await request.json().catch(() => null);
  const messages = cleanMessages(body?.messages);
  if (!messages) return json({ error: "bad_request", message: "Invalid conversation." }, 400);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (s.apiKey) headers.Authorization = `Bearer ${s.apiKey}`;

  let upstream: Response;
  try {
    upstream = await fetch(`${s.host}/api/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: s.model,
        stream: true,
        messages: [{ role: "system", content: env("CHAT_SYSTEM_PROMPT") ?? DEFAULT_SYSTEM_PROMPT }, ...messages],
      }),
      signal: request.signal,
    });
  } catch (err) {
    console.error("Ollama unreachable", err);
    return json({ error: "upstream_unreachable", message: "Couldn't reach the AI server." }, 502);
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    console.error("Ollama error", upstream.status, detail);
    const message =
      upstream.status === 401 || upstream.status === 403
        ? "The AI server rejected the API key."
        : upstream.status === 404
          ? `Model "${s.model}" wasn't found on the AI server.`
          : upstream.status === 429
            ? "The AI is getting too many requests right now. Try again shortly."
            : "The AI server returned an error.";
    return json({ error: "upstream", status: upstream.status, message }, 502);
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
