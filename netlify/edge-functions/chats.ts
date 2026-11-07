// Saved AI conversations, so the chat page can show a history sidebar that follows you
// across devices. Each logged-in person only ever sees their own chats.
// Runs after the "auth" edge function (see netlify.toml), and re-checks the login cookie
// itself to know whose chats to load.
//
// GET    /api/chats        → { chats: [{ id, title, createdAt, updatedAt, count }] }  (newest first)
// GET    /api/chats/:id    → { id, title, createdAt, updatedAt, messages }
// PUT    /api/chats/:id    → body { title?, messages }  create or replace a chat
// PATCH  /api/chats/:id    → body { title }             rename
// DELETE /api/chats/:id                                 delete
//
// Stored in Netlify Blobs (store "ai-chats"):
//   <userKey>/index        list of chat summaries
//   <userKey>/c/<chatId>   one full conversation

import type { Context } from "@netlify/edge-functions";
import { getStore } from "@netlify/blobs";
import { SESSION_COOKIE, sessionUser } from "../shared/session.ts";

const MAX_CHATS = 500;
const MAX_MESSAGES = 400;
const MAX_CHARS_PER_MESSAGE = 32_000;
const MAX_TITLE = 80;
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

type Msg = { role: "user" | "assistant"; content: string };
type Summary = { id: string; title: string; createdAt: string; updatedAt: string; count: number };
type Chat = Omit<Summary, "count"> & { messages: Msg[] };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function store() {
  try {
    return getStore({ name: "ai-chats", consistency: "strong" });
  } catch {
    return getStore("ai-chats");
  }
}

function cleanTitle(value: unknown, fallback: string): string {
  const t = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return (t || fallback).slice(0, MAX_TITLE);
}

function titleFrom(messages: Msg[]): string {
  const first = messages.find((m) => m.role === "user")?.content ?? "New chat";
  return cleanTitle(first.replace(/[`*#>_~]/g, ""), "New chat");
}

function cleanMessages(input: unknown): Msg[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const out: Msg[] = [];
  for (const m of input.slice(-MAX_MESSAGES)) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") return null;
    out.push({ role: m.role, content: m.content.slice(0, MAX_CHARS_PER_MESSAGE) });
  }
  return out;
}

async function readIndex(s: ReturnType<typeof store>, userKey: string): Promise<Summary[]> {
  const list = (await s.get(`${userKey}/index`, { type: "json" })) as Summary[] | null;
  return Array.isArray(list) ? list : [];
}

async function writeIndex(s: ReturnType<typeof store>, userKey: string, list: Summary[]) {
  list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  await s.setJSON(`${userKey}/index`, list);
}

export default async function handler(request: Request, context: Context) {
  const user = await sessionUser(context.cookies.get(SESSION_COOKIE));
  if (!user) return json({ error: "unauthorised", message: "Please log in again." }, 401);

  const url = new URL(request.url);
  const id = url.pathname.replace(/^\/api\/chats\/?/, "").split("/")[0] || null;
  if (id !== null && !ID_PATTERN.test(id)) return json({ error: "bad_id" }, 400);

  try {
    const s = store();

    // List
    if (!id) {
      if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
      return json({ chats: await readIndex(s, user.key) });
    }

    const chatKey = `${user.key}/c/${id}`;

    if (request.method === "GET") {
      const chat = (await s.get(chatKey, { type: "json" })) as Chat | null;
      return chat ? json(chat) : json({ error: "not_found" }, 404);
    }

    if (request.method === "PUT") {
      const body = await request.json().catch(() => null);
      const messages = cleanMessages(body?.messages);
      if (!messages) return json({ error: "bad_request", message: "Invalid conversation." }, 400);

      const index = await readIndex(s, user.key);
      const existing = index.find((c) => c.id === id);
      if (!existing && index.length >= MAX_CHATS) {
        return json({ error: "too_many", message: `You can keep up to ${MAX_CHATS} chats. Delete some old ones first.` }, 409);
      }
      const now = new Date().toISOString();
      const chat: Chat = {
        id,
        title: cleanTitle(body?.title, existing?.title ?? titleFrom(messages)),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        messages,
      };
      await s.setJSON(chatKey, chat);
      const summary: Summary = { id, title: chat.title, createdAt: chat.createdAt, updatedAt: now, count: messages.length };
      await writeIndex(s, user.key, [summary, ...index.filter((c) => c.id !== id)]);
      return json(summary);
    }

    if (request.method === "PATCH") {
      const body = await request.json().catch(() => null);
      const chat = (await s.get(chatKey, { type: "json" })) as Chat | null;
      if (!chat) return json({ error: "not_found" }, 404);
      chat.title = cleanTitle(body?.title, chat.title);
      await s.setJSON(chatKey, chat);
      const index = await readIndex(s, user.key);
      const entry = index.find((c) => c.id === id);
      if (entry) entry.title = chat.title;
      await writeIndex(s, user.key, index);
      return json({ id, title: chat.title });
    }

    if (request.method === "DELETE") {
      await s.delete(chatKey);
      const index = await readIndex(s, user.key);
      await writeIndex(s, user.key, index.filter((c) => c.id !== id));
      return json({ ok: true });
    }

    return json({ error: "method_not_allowed" }, 405);
  } catch (err) {
    console.error("chat history storage error", err);
    return json({ error: "storage", message: "Chat history is unavailable right now." }, 503);
  }
}
