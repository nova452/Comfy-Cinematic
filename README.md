# Comfy Cinematic

<img width="640" height="360" alt="image-1793248505453" src="https://github.com/user-attachments/assets/86aa9efc-bc03-497c-8d78-80ebd56f21b6" />


Live demo at: https://comfy-cinematic.ai.studio/



### Router or local, one switch

Every model has a Router entry and a Local entry side by side in its picker:

- **FLUX 3** / **FLUX 3 Local** for stills, and **MiniMax H3** (Original / Max / Turbo) /
  **MiniMax H3 Local** for clips.
- Local renders go to whichever target is selected in **Manage account**:
  - **Deployment**: a hosted Comfy build (`https://dep-….run.comfy.app`), using your Comfy key.
  - **Comfy Desktop**: your own ComfyUI, directly (`http://127.0.0.1:8188`) or behind
    `comfy-api-proxy`.
- The **gear** on a Local row sets the diffusion model, text encoder and step count, and **Verify**
  checks those files exist on the target before you spend a render.
- Local renders on your own machine cost no credits. Router renders, and jobs on a hosted
  deployment, are billed to your Comfy workspace.

### Assets

The **Assets** tab is every upload and every render in the project in one library:

- **Uploads**, **Output** and **Saved** (starred) tabs.
- **Recent / Images / Videos / Audio** filters.
- Click any tile to see it full size. The same library opens from every reference slot, so a still
  on the canvas can become a first frame and a finished clip can become the next video reference.

### The canvas

- Frames lay out on a grid as they land. Drag them anywhere, and undo/redo everything.
- A render claims its slot before the request goes out, shown as a blueprint square with the prompt.
  Drag it, and the result lands where you left it.
- Select a frame to **View**, **Reuse** (put its exact settings back in the panel), **Continue**,
  **Download** or **Delete**.
- The viewer shows a clip or portrait still at its own shape, with the prompt you typed and the
  settings it was made with.
- **Chat**: ask a question instead of describing a frame, and it answers in the Chat tab.
---

## Run it yourself

You need Node 22.6+ and a [Comfy API key](https://platform.comfy.org/profile/api-keys?onboarding=router)
for a workspace with Router access.

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Open <http://127.0.0.1:3000> and sign in from the header. Or put the key in `COMFY_API_KEY` for a
self-hosted studio. For local renders, open **Manage account** and point it at your deployment or
your ComfyUI.
