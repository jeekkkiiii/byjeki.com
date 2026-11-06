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
