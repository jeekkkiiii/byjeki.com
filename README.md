# byjeki.com
my website that has my cv and other tools that i want to showcase and use

## Deployment (Netlify)
This is a static site with no build step. `netlify.toml` tells Netlify to publish the repo root.

1. In Netlify: **Add new site → Import an existing project → GitHub** and pick `jeekkkiiii/byjeki.com`.
2. Branch to deploy: `main`. Build command: *(leave empty)*. Publish directory: `.`
3. Every push to `main` redeploys the site automatically.

## Login
The whole site sits behind a login page (`login.html`), enforced server-side by a Netlify Edge Function (`netlify/edge-functions/auth.ts`).

Set these in **Netlify → Site configuration → Environment variables**, then redeploy:

| Variable | Required | Purpose |
|---|---|---|
| `SITE_USERNAME` | yes | Login username |
| `SITE_PASSWORD` | yes | Login password |
| `SESSION_SECRET` | recommended | Long random string used to sign session cookies (changing it logs everyone out) |

Sessions last 7 days. Visit `/logout` (or the LOGOUT link in the nav) to sign out.
Until `SITE_USERNAME` and `SITE_PASSWORD` are set, the site returns a "not configured" message instead of the content.

## Google sign-in
"Continue with Google" appears on the login page once these are set in Netlify (then redeploy):

| Variable | Secret? | Purpose |
|---|---|---|
| `GOOGLE_CLIENT_ID` | no | OAuth client ID from Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | yes | OAuth client secret |
| `ALLOWED_EMAILS` | no | Who may get in with Google, comma separated. `@company.com` allows a whole domain, `*` allows anyone. Unset = nobody. |

Google Cloud setup: create an **OAuth client ID** (type *Web application*) with
- Authorised JavaScript origin: `https://byjeki.com`
- Authorised redirect URI: `https://byjeki.com/auth/google/callback`

(Add the same pair for any other domain you log in through, e.g. `https://<site>.netlify.app`.)
Removing an email from `ALLOWED_EMAILS` revokes that person's access on their next page load.

## AI Chat
`chat.html` (the **AI CHAT** link in the nav) is a chat page behind the login. The browser talks to
`/api/chat` (`netlify/edge-functions/chat.ts`), which forwards the conversation to an Ollama server,
so API keys never reach the browser. Until it's configured the page shows "NOT CONNECTED".

| Variable | Secret? | Purpose |
|---|---|---|
| `OLLAMA_API_KEY` | yes | API key from ollama.com (needed for Ollama Cloud) |
| `OLLAMA_MODEL` | no | Model to use, e.g. `gpt-oss:120b` (default) or `gpt-oss:20b` |
| `OLLAMA_HOST` | no | Optional. Defaults to `https://ollama.com`. Set to your own Ollama server's public URL to self-host |
| `CHAT_SYSTEM_PROMPT` | no | Optional. Personality/instructions for the assistant |

### Option 1 – Ollama Cloud (recommended)
1. Sign up at ollama.com → **Settings → API keys** → create a key.
2. Add `OLLAMA_API_KEY` (secret) and `OLLAMA_MODEL` in Netlify, then redeploy.

### Option 2 – Ollama on your own computer (advanced)
Netlify can't reach `localhost`, so your PC must be exposed with a tunnel (e.g. Cloudflare Tunnel),
then set `OLLAMA_HOST` to the tunnel URL and `OLLAMA_MODEL` to a model you've pulled.
⚠️ A bare tunnel lets anyone who finds the URL use your Ollama; protect it (e.g. Cloudflare Access)
and note your PC must stay on for the chat to work.
