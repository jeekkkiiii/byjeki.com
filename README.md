# byjeki.com
my website that has my cv and other tools that i want to showcase and use

## Deployment (Netlify)
This is a static site with no build step. `netlify.toml` tells Netlify to publish the repo root.

1. In Netlify: **Add new site → Import an existing project → GitHub** and pick `jeekkkiiii/byjeki.com`.
2. Branch to deploy: `main`. Build command: *(leave empty)*. Publish directory: `.`
3. Every push to `main` redeploys the site automatically.
