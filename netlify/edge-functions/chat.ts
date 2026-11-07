// AI chat backend: forwards the conversation to Groq (or any OpenAI-compatible API)
// and streams the reply back to the browser.
// Runs after the "auth" edge function (see netlify.toml), so only logged-in visitors reach it.
//
// Environment variables (Netlify → Site configuration → Environment variables):
//   GROQ_API_KEY       – required; free key from console.groq.com → API Keys
//   AI_MODEL           – optional; defaults to openai/gpt-oss-120b
//   AI_BASE_URL        – optional; defaults to https://api.groq.com/openai/v1
//                        (point at another OpenAI-compatible provider to switch, e.g.
//                        https://openrouter.ai/api/v1 or
//                        https://generativelanguage.googleapis.com/v1beta/openai)
//   CHAT_SYSTEM_PROMPT – optional; instructions/personality for the assistant
//
// GET  /api/chat → { configured, model }   (used by the page to show status)
// POST /api/chat → body { messages: [{ role: "user" | "assistant", content: string }] }
//                  streams newline-delimited JSON lines to the browser:
//                    {"message":{"content":"..."}}   – a piece of the reply
//                    {"message":{"thinking":"..."}}  – the model is reasoning
//                    {"error":"..."}                 – something went wrong mid-reply
//                    {"done":true}                   – finished

import type { Context } from "@netlify/edge-functions";

const MAX_MESSAGES = 40;
const MAX_CHARS_PER_MESSAGE = 8000;
const MAX_TOTAL_CHARS = 48000;
// Known providers. If AI_BASE_URL isn't set, the provider is picked from the API key's format.
const PROVIDERS = {
  groq: { name: "Groq", baseUrl: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b" },
  gemini: {
    name: "Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-flash-lite-latest",
  },
} as const;
const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful, friendly AI assistant on Jeki's personal portfolio website (byjeki.com). " +
  "Answer clearly and concisely. Use Markdown for formatting, including fenced code blocks for code.";

const enc = new TextEncoder();

function env(name: string): string | undefined {
  return Netlify.env.get(name)?.trim() || undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function providerFor(apiKey: string | undefined, baseUrl: string | undefined) {
  if (baseUrl) {
    const host = baseUrl.toLowerCase();
    if (host.includes("googleapis.com")) return PROVIDERS.gemini;
    if (host.includes("groq.com")) return PROVIDERS.groq;
    return null;
  }
  if (apiKey?.startsWith("AIza")) return PROVIDERS.gemini;
  return PROVIDERS.groq;
}

function settings() {
  const apiKey = env("AI_API_KEY") ?? env("GROQ_API_KEY");
  const customBase = env("AI_BASE_URL")?.replace(/\/+$/, "");
  const provider = providerFor(apiKey, customBase);
  const baseUrl = customBase ?? provider!.baseUrl;
  const model = (env("AI_MODEL") ?? provider?.model ?? "").replace(/^models\//, "");
  let providerName: string = provider?.name ?? "the AI service";
  let validBase = true;
  try {
    const u = new URL(baseUrl);
    if (!provider) providerName = u.hostname;
  } catch {
    validBase = false;
  }
  return { apiKey, baseUrl, model, providerName, configured: !!apiKey && !!model && validBase };
}

// Looks up which models the provider offers, to suggest alternatives when a model isn't found.
async function suggestModels(baseUrl: string, apiKey: string, wanted: string): Promise<string[]> {
  try {
    const res = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) return [];
    const ids: string[] = ((await res.json())?.data ?? [])
      .map((m: { id?: string }) => String(m.id ?? "").replace(/^models\//, ""))
      .filter((id: string) => id && !/embed|tts|image|audio|whisper|guard|veo|imagen/i.test(id));
    const words = wanted.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !/^\d+$/.test(w));
    const score = (id: string) => words.filter((w) => id.toLowerCase().includes(w)).length;
    return ids.sort((a, b) => score(b) - score(a)).slice(0, 5);
  } catch {
    return [];
  }
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

function friendlyError(status: number, model: string, provider: string): string {
  if (status === 400 || status === 401 || status === 403) return `${provider} rejected the request — check the API key is correct and belongs to ${provider}.`;
  if (status === 404) return `Model "${model}" wasn't found on ${provider}.`;
  if (status === 413) return "This conversation is too long. Start a new chat.";
  if (status === 429) return "The AI has hit its free usage limit for now. Try again in a little while.";
  if (status >= 500) return "The AI service is having problems right now. Try again shortly.";
  return "The AI service returned an error.";
}

// Converts an OpenAI-style Server-Sent Events stream into the NDJSON lines the page reads.
function sseToNdjson(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = "";
  const line = (obj: unknown) => enc.encode(JSON.stringify(obj) + "\n");

  function handleEvent(data: string, out: TransformStreamDefaultController<Uint8Array>) {
    if (data === "[DONE]") return;
    let evt: any;
    try {
      evt = JSON.parse(data);
    } catch {
      return;
    }
    if (evt.error) {
      out.enqueue(line({ error: evt.error.message ?? "The AI service returned an error." }));
      return;
    }
    const delta = evt.choices?.[0]?.delta ?? {};
    if (delta.reasoning) out.enqueue(line({ message: { thinking: delta.reasoning } }));
    if (delta.content) out.enqueue(line({ message: { content: delta.content } }));
  }

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, out) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const l of lines) if (l.startsWith("data:")) handleEvent(l.slice(5).trim(), out);
      },
      flush(out) {
        if (buffer.startsWith("data:")) handleEvent(buffer.slice(5).trim(), out);
        out.enqueue(line({ done: true }));
      },
    }),
  );
}

export default async function handler(request: Request, _context: Context) {
  const s = settings();

  if (request.method === "GET") {
    return json({
      configured: s.configured,
      provider: s.configured ? s.providerName : null,
      model: s.configured ? s.model.replace(/^.*\//, "") : null,
    });
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

  let upstream: Response;
  try {
    upstream = await fetch(`${s.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.apiKey}` },
      body: JSON.stringify({
        model: s.model,
        stream: true,
        messages: [{ role: "system", content: env("CHAT_SYSTEM_PROMPT") ?? DEFAULT_SYSTEM_PROMPT }, ...messages],
      }),
      signal: request.signal,
    });
  } catch (err) {
    console.error("AI service unreachable", err);
    return json({ error: "upstream_unreachable", message: "Couldn't reach the AI service." }, 502);
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    console.error("AI service error", upstream.status, detail);
    let message = friendlyError(upstream.status, s.model, s.providerName);
    if (upstream.status === 404) {
      const options = await suggestModels(s.baseUrl, s.apiKey!, s.model);
      message += options.length
        ? ` Set AI_MODEL in Netlify to one of: ${options.join(", ")}`
        : " Check AI_MODEL and AI_BASE_URL in Netlify.";
    }
    return json({ error: "upstream", status: upstream.status, message }, 502);
  }

  return new Response(sseToNdjson(upstream.body), {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
