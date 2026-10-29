
# Comfy Cinematic

Live at: https://comfy-cinematic.ai.studio/

Demo: https://x.com/Enchant62923386/status/2115742611554361424

A mobile app for all your Comfy needs, runs on the browser.

Motion reference, Object swap, clip looping and more
<img width="1200" height="226" alt="minimax-trio-light" src="https://github.com/user-attachments/assets/925958ed-a5a9-4125-8a6b-d7f45a53a364" />

Supports the local comfy desktop and the developer platform, workflows are automatically generated as you press generate.
Every model has a Router entry and a Local entry side by side in its picker:

- FLUX 3 / FLUX 3 Local for stills, and MiniMax H3 (Original / Max / Turbo) /
  MiniMax H3 Local for clips.
- Local renders go to whichever target is selected in Manage account:
  - Deployment: a hosted Comfy build (`https://dep-….run.comfy.app`).
  - Comfy Desktop: your own ComfyUI, directly (`http://127.0.0.1:8188`) or behind
    `comfy-api-proxy`.



## Run it yourself

You need Node 22.6+ and a [Comfy API key](https://platform.comfy.org/profile/api-keys?onboarding=router)
for a workspace with Router access.

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Open <http://127.0.0.1:3000> and sign in from the header. Or put the key in `COMFY_API_KEY` for a
self-hosted studio.
