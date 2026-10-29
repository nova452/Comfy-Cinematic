# Comfy Cinematic

**A project-based canvas for Comfy Router.** Open a project, describe an image, and a frame lands
on an infinite canvas you can pan, zoom, drag, undo and share. Ask a question instead and the
harness answers it in the Chat tab.

- **Stills** — FLUX 3 through Comfy Router, or the same stack on your own ComfyUI. Sixteen aspect
  ratios, five size classes from 0.75K to 4K, batches of up to four.
- **Clips** — MiniMax H3 on Router or local, with keyframes, reference clips and soundtracks.
- **Local renders are free** — the same models run on your ComfyUI; Router renders cost credits.
- **Private by default** — projects, renders and uploads never reach the server: they live in this
  browser (IndexedDB), and the Comfy key lives in its localStorage.

## Quick start

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:3000`, sign in with a Comfy Router key (top right) or point Manage account
at your own ComfyUI, and describe a frame.

## Documentation

The full guide — the design language, the harness, the local graphs, every environment variable —
lives in [README-LONG.md](README-LONG.md).

## License

MIT — see [LICENSE](LICENSE).
