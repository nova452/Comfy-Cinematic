# Comfy Cinematic

<img width="320" height="180" alt="image-1793248505453" src="https://github.com/user-attachments/assets/86aa9efc-bc03-497c-8d78-80ebd56f21b6" />


Live at: https://comfy-cinematic.ai.studio/

Demo: https://x.com/Enchant62923386/status/2115742611554361424



## Router or local, one switch

Every model has a Router entry and a Local entry side by side in its picker:

- FLUX 3 / FLUX 3 Local for stills, and MiniMax H3 (Original / Max / Turbo) /
  MiniMax H3 Local for clips.
- Local renders go to whichever target is selected in Manage account:
  - Deployment: a hosted Comfy build (`https://dep-….run.comfy.app`), using your Comfy key.
  - Comfy Desktop: your own ComfyUI, directly (`http://127.0.0.1:8188`) or behind
    `comfy-api-proxy`.
- The gear on a Local row sets the diffusion model, text encoder and step count, and Verify
  checks those files exist on the target before you spend a render.
- Local renders on your own machine cost no credits. Router renders, and jobs on a hosted
  deployment, are billed to your Comfy workspace.



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
