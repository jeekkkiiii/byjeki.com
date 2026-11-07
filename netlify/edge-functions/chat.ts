// AI chat backend: forwards the conversation to Gemini or Groq (any OpenAI-compatible API)
// and streams the reply back to the browser. Also keeps a daily token budget (the "HP bar").
// Runs after the "auth" edge function (see netlify.toml), so only logged-in visitors reach it.
//
// Environment variables (Netlify → Site configuration → Environment variables):
//   AI_API_KEY         – Gemini key (AIza… / AQ.…) or Groq key. GROQ_API_KEY also accepted.
//   AI_MODEL           – optional; defaults to gemini-flash-lite-latest (Gemini) / openai/gpt-oss-120b (Groq)
//   AI_BASE_URL        – optional; only for other OpenAI-compatible providers
//   AI_DAILY_TOKENS    – optional; daily token budget shown in the HP bar (default 500000).
//   AI_DAILY_REQUESTS  – optional; daily request budget shown next to it (default 250).
//                        Set it to your model's "requests per day" from AI Studio → Rate limits.
//                        Both reset at midnight Pacific time, like Google's free-tier limits.
//   CHAT_SYSTEM_PROMPT – optional; instructions/personality for the assistant
//
// GET  /api/chat → { configured, provider, model, usage }
// POST /api/chat → body { messages: [{ role: "user" | "assistant", content: string }] }
//                  streams newline-delimited JSON lines to the browser:
//                    {"message":{"content":"..."}}   – a piece of the reply
//                    {"message":{"thinking":"..."}}  – the model is reasoning
//                    {"error":"..."}                 – something went wrong mid-reply
//                    {"usage":{...}}                 – updated token budget
//                    {"done":true}                   – finished
//   usage = { used, limit, requests, requestLimit, resetsAt } or null if tracking is unavailable

import type { Context } from "@netlify/edge-functions";
import { getStore } from "@netlify/blobs";

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

const DEFAULT_DAILY_TOKENS = 500_000;
const DEFAULT_DAILY_REQUESTS = 250;

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

function providerFor(apiKey: string | undefined, baseUrl: string | undefined, model: string | undefined) {
  if (baseUrl) {
    const host = baseUrl.toLowerCase();
    if (host.includes("googleapis.com")) return PROVIDERS.gemini;
    if (host.includes("groq.com")) return PROVIDERS.groq;
    return null;
  }
  // Google keys start with "AIza" (classic) or "AQ." (newer format); gemini/gemma models are Google's too.
  if (apiKey?.startsWith("AIza") || apiKey?.startsWith("AQ.")) return PROVIDERS.gemini;
  if (model && /^(models\/)?(gemini|gemma)/i.test(model)) return PROVIDERS.gemini;
  return PROVIDERS.groq;
}

function settings() {
  const apiKey = env("AI_API_KEY") ?? env("GROQ_API_KEY");
  const customBase = env("AI_BASE_URL")?.replace(/\/+$/, "");
  const provider = providerFor(apiKey, customBase, env("AI_MODEL"));
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

// ─── daily token budget (stored in Netlify Blobs) ──────────────────────────

type Usage = { used: number; limit: number; requests: number; requestLimit: number; resetsAt: string };
type DayRecord = { tokens?: number; requests?: number; providerExhausted?: boolean };

function numberEnv(name: string, fallback: number): number {
  const n = Number(env(name)?.replace(/[,_\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function toUsage(data: DayRecord | null, resetsAt: string): Usage {
  const requestLimit = numberEnv("AI_DAILY_REQUESTS", DEFAULT_DAILY_REQUESTS);
  return {
    used: data?.tokens ?? 0,
    limit: numberEnv("AI_DAILY_TOKENS", DEFAULT_DAILY_TOKENS),
    // If the provider told us its daily request quota is gone, show 0 left whatever our count says.
    requests: data?.providerExhausted ? requestLimit : Math.min(data?.requests ?? 0, requestLimit),
    requestLimit,
    resetsAt,
  };
}

// Google's free-tier daily limits reset at midnight Pacific time, so the budget does too.
function pacificDay(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(now).map((p) => [p.type, p.value]),
  );
  const secondsIntoDay = Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  return {
    key: `${parts.year}-${parts.month}-${parts.day}`,
    resetsAt: new Date(now.getTime() + (86400 - secondsIntoDay) * 1000).toISOString(),
  };
}

function usageStore() {
  try {
    return getStore({ name: "ai-usage", consistency: "strong" });
  } catch {
    return getStore("ai-usage");
  }
}

async function readUsage(): Promise<Usage | null> {
  try {
    const day = pacificDay();
    const data = (await usageStore().get(day.key, { type: "json" })) as DayRecord | null;
    return toUsage(data, day.resetsAt);
  } catch (err) {
    console.error("usage read failed", err);
    return null;
  }
}

async function addUsage(tokens: number): Promise<Usage | null> {
  try {
    const day = pacificDay();
    const store = usageStore();
    const data = ((await store.get(day.key, { type: "json" })) ?? {}) as DayRecord;
    const next = { ...data, tokens: (data.tokens ?? 0) + tokens, requests: (data.requests ?? 0) + 1 };
    await store.setJSON(day.key, next);
    return toUsage(next, day.resetsAt);
  } catch (err) {
    console.error("usage write failed", err);
    return null;
  }
}

// Called when the provider says its *daily* quota is used up, so the counter shows 0 until reset.
async function markProviderExhausted(): Promise<Usage | null> {
  try {
    const day = pacificDay();
    const store = usageStore();
    const data = ((await store.get(day.key, { type: "json" })) ?? {}) as DayRecord;
    const next = { ...data, providerExhausted: true };
    await store.setJSON(day.key, next);
    return toUsage(next, day.resetsAt);
  } catch (err) {
    console.error("usage write failed", err);
    return null;
  }
}

// Converts an OpenAI-style Server-Sent Events stream into the NDJSON lines the page reads.
// When the stream ends, onFinish is given the token count the provider reported (or null)
// plus how many characters were generated, and returns the updated budget.
function sseToNdjson(
  body: ReadableStream<Uint8Array>,
  onFinish: (reportedTokens: number | null, outputChars: number) => Promise<Usage | null>,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = "";
  let reportedTokens: number | null = null;
  let outputChars = 0;
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
    const usage = evt.usage ?? evt.x_groq?.usage;
    if (usage && Number.isFinite(usage.total_tokens)) reportedTokens = usage.total_tokens;
    const delta = evt.choices?.[0]?.delta ?? {};
    if (delta.reasoning) {
      outputChars += String(delta.reasoning).length;
      out.enqueue(line({ message: { thinking: delta.reasoning } }));
    }
    if (delta.content) {
      outputChars += String(delta.content).length;
      out.enqueue(line({ message: { content: delta.content } }));
    }
  }

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, out) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const l of lines) if (l.startsWith("data:")) handleEvent(l.slice(5).trim(), out);
      },
      async flush(out) {
        if (buffer.startsWith("data:")) handleEvent(buffer.slice(5).trim(), out);
        out.enqueue(line({ usage: await onFinish(reportedTokens, outputChars) }));
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
      usage: s.configured ? await readUsage() : null,
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

  const ukTime = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
  const before = await readUsage();
  if (before && before.used >= before.limit) {
    return json({
      error: "budget",
      message: `Out of HP! Today's AI token budget is used up. It refills at ${ukTime(before.resetsAt)} (UK time).`,
      usage: before,
    }, 429);
  }
  if (before && before.requests >= before.requestLimit) {
    return json({
      error: "requests",
      message: `Out of requests! Today's AI request budget is used up. It refills at ${ukTime(before.resetsAt)} (UK time).`,
      usage: before,
    }, 429);
  }
  const systemPrompt = env("CHAT_SYSTEM_PROMPT") ?? DEFAULT_SYSTEM_PROMPT;
  const inputChars = systemPrompt.length + messages.reduce((n, m) => n + m.content.length, 0);

  const callAI = (withUsage: boolean) =>
    fetch(`${s.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.apiKey}` },
      body: JSON.stringify({
        model: s.model,
        stream: true,
        ...(withUsage ? { stream_options: { include_usage: true } } : {}),
        messages: [{ role: "system", content: systemPrompt }, ...messages],
      }),
      signal: request.signal,
    });

  let upstream: Response;
  try {
    upstream = await callAI(true);
    // Some providers reject stream_options; retry once without it (usage is then estimated).
    if (upstream.status === 400) {
      const detail = await upstream.text().catch(() => "");
      if (/stream_options|include_usage/i.test(detail)) upstream = await callAI(false);
      else upstream = new Response(detail, { status: 400 });
    }
  } catch (err) {
    console.error("AI service unreachable", err);
    return json({ error: "upstream_unreachable", message: "Couldn't reach the AI service." }, 502);
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    console.error("AI service error", upstream.status, detail);
    let message = friendlyError(upstream.status, s.model, s.providerName);
    // Google names daily quotas e.g. "GenerateRequestsPerDayPerProjectPerModel-FreeTier".
    if (upstream.status === 429 && /per\s?day/i.test(detail)) {
      const usage = await markProviderExhausted();
      const refill = usage ? ` It refills at ${ukTime(usage.resetsAt)} (UK time).` : "";
      return json({
        error: "requests",
        message: `Out of requests! ${s.providerName}'s free daily request limit has been reached.${refill}`,
        usage,
      }, 429);
    }
    if (upstream.status === 429) {
      message = `${s.providerName}'s per-minute limit was hit. Wait a minute and try again.`;
    }
    if (upstream.status === 404) {
      const options = await suggestModels(s.baseUrl, s.apiKey!, s.model);
      message += options.length
        ? ` Set AI_MODEL in Netlify to one of: ${options.join(", ")}`
        : " Check AI_MODEL and AI_BASE_URL in Netlify.";
    }
    return json({ error: "upstream", status: upstream.status, message }, 502);
  }

  // If the provider doesn't report usage, estimate ~4 characters per token.
  const onFinish = (reported: number | null, outputChars: number) =>
    addUsage(reported ?? Math.ceil((inputChars + outputChars) / 4));

  return new Response(sseToNdjson(upstream.body, onFinish), {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
