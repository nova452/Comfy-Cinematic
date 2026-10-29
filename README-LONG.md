# Comfy Cinematic

**A project-based canvas for Comfy Router.** Open a project, describe an image, and a frame lands on
an infinite canvas you can pan, zoom, drag, undo and share. Ask a question instead
and the harness answers it in the Chat tab.

Built on FLUX 3 — either `bfl/flux-3-image` through Comfy Router or the same stack on
your own ComfyUI — with sixteen aspect ratios, five size classes from 0.75K to 4K, and
batches of up to four images.

---

## The look

The interface follows Comfy's own design language rather than a generic dark theme. Tokens
sampled straight from comfy.org:

| Token | Value | Use |
| --- | --- | --- |
| Plum | `#211927` | page background |
| Deep plum | `#1B1421` | canvas, inputs |
| Lime | `#F2FF59` | primary action, selection, focus |
| Warm white | `#F0EFED` | text |
| Muted | `#C2BFB9` | secondary text |
| Ghost | `rgba(255,255,255,.08)` | secondary buttons and tags |

Details that carry the brand:

- **Pills, not rectangles.** Buttons and tags are 16px-radius pills, uppercase, 700 weight, with
  wide letter-spacing.
- **The notched tag.** The model pill and the ratio / size / batch chips are solid blocks with the top-right
  corner clipped — Comfy's signature tag shape, done with `clip-path`.
- **Condensed poster type.** Headings are Anton, uppercase and tight; UI text is Space Grotesk.
  Both are self-hosted through `next/font`, so there is no runtime request to a font CDN. Comfy's
  own face (PP Formula) is licensed, so this is a close stand-in, not a copy.
- **A rounded canvas.** The work surface is an inset, bordered, dotted panel rather than a
  full-bleed void, echoing the bordered media blocks on comfy.org.
- **Lime everywhere it means something.** Selection outlines, the active tool, the active tab
  underline, the frame index, focus rings.

---

## The shape of it

```
/                     projects grid — create, open, delete
/p/<id>               the canvas workspace

app/api/account       check a key, read its balance
app/api/harness       one prompt in → answer or still (bytes returned inline)
app/api/video         one prompt in → clip (bytes returned inline)
app/api/local-model/verify   does the target have these H3 files?
app/api/local-image/verify   does the target have these FLUX files?

Projects, renders and uploads never reach the server: they live in this
browser (IndexedDB), and the Comfy key lives in its localStorage.
```

### Projects home

Every project is a card with its first render as the thumbnail, the render count and a relative
timestamp. Creating one takes you straight into its canvas. Nothing to configure first.

### The workspace

The layout is the one people already know from design tools:

- **Floating project card** top-left — back, editable name, save state, and Share: a preview card with
  Post on X and Copy link.
- **Floating status** top-right — the registered model and a way back to the grid.
- **Left rail** — `Create`, `Video`, `Chat` and `Assets` tabs.
  - *Create*: the image model picker (FLUX 3 on Router or Local) with an **Edit** switch on the same
    row, a bordered prompt box with up to four generic reference-image slots, the ratio / size / batch
    chips, and Generate. Enter generates; Shift+Enter makes a newline.
  - *Video*: the video tool, its Mode selector and Generate clip.
  - *Chat*: the transcript of everything you have asked, with full replies and a composer.
  - *Assets*: the same library the reference picker shows, but with no slot to fill and no kind to
    filter by — every still, clip and track in one grid, newest first, each carrying the symbol for
    what it is. `Recent` shows everything; `Images`, `Videos` and `Audio` narrow it. A render that is
    still running appears here as the same blueprint square the canvas draws, so the library never
    looks emptier than the canvas. Clicking a tile opens it full size; the star keeps it in
   **Saved**. Uploads are written to this browser's media store and their sources are
    kept in the project document, so the library survives a reload and an uploaded still can be
    picked later as a first frame.
- **Infinite canvas** — dot grid, pan (hand tool or hold space), zoom (wheel, ±, or fit), frames
  laid out on a 3-column grid as they arrive.
- **Frames** — drag to reposition, click to select; selecting shows View / Reuse / Download / Delete.
- **Reserved slots** — a render takes its place on the canvas before the request goes out: a
  blueprint square carrying the prompt sits where the result will land and fills from the bottom
  while it works, then the still or clip fills that same slot. The fill is paced by elapsed time —
  a clip climbs slower than a still — and stops short of the top, because nothing streams back from
  the provider; the arriving frame is what completes it. The square is **draggable** like a frame, so
  you can move a slow clip next to the shot it belongs with, and the clip lands wherever you left the
  blueprint: the drop position is read when the response arrives, not when the request went out.
  Because the slot is claimed up front, two renders can never be handed the same one, and a frame you
  dragged off the grid still owns the space it covers (`nextPosition` tests for a rect overlap, not
  an exact coordinate match).
- **Selection bar** — floats just above the selected frame and follows it as you drag or zoom. Near the
  top edge it drops below the frame instead, and it is clamped inside the canvas at both ends so a
  corner can never clip it. **Delete** arms itself on the first press — it reads `Sure?` for three
  seconds — and only the second press removes the frame; selecting anything else disarms it.
- **Bottom dock** — select/hand, zoom out / percentage / zoom in / fit, undo / redo. On narrow
  screens the dock folds into the panel as an inline toolbar.
- **Bottom right** — canvas total: clip runtime in seconds when the project holds clips (`15s of
  clip`), otherwise a still count (`4 stills`).

Keyboard: `Delete` removes the selected frame, `Esc` closes the viewer and then deselects,
`Cmd/Ctrl+Z` undoes, `Shift+Cmd/Ctrl+Z` redoes, holding `Space` pans. A single click on empty canvas
clears the selection too, so there is nothing to cancel on the way to the next frame.

Double-click a frame — or press **View** on its selection bar, which is the same thing for a touch
screen — to open it full size. A canvas frame is a square `object-fit: cover` crop, so this is where
a clip or a portrait still is seen whole: the media at its own shape with native video controls, the
prompt **you typed**, the model, ratio, size, mode, duration, style and enhancer as chips, and
Download / Reuse / Delete. The backdrop and `Esc` close it, and the frame stays
selected underneath, so closing lands back where you were. On a narrow screen the media stacks above
the panel rather than beside it.

### Create controls

The three chips under the prompt are the same picker the video panel uses. **Aspect ratio** offers
FLUX 3's sixteen shapes (`auto` included), **Resolution** offers its five size classes (`768sq`,
`1k`, `1.5k`, `2k`, `4k`), and **Batch** asks for one to four images. A Router batch is that many
model calls collected into frames; the local graph sets `batch_size` on one `EmptyLatentImage` and
returns every file the save node wrote. Local renders are text-to-image only, so the reference slots
disappear. Shape, size and batch are recorded in the frame's recipe, so Reuse puts them back.

### The sent prompt is metadata, not the headline

What the model was actually given is folded away under **Prompt sent** — a still's version is the
enhanced prompt, and a reference clip's is the six-section rewrite, which is several paragraphs and
nobody's idea of a caption. The frame stores it in `recipe`, along with everything else the call was
made with (`lib/projects.ts`):

```json
{
  "prompt": "subject_definitions: <Subject 1> is …",
  "sourcePrompt": "swap the rider",
  "recipe": {
    "tab": "video",
    "ratio": "9:16",
    "resolution": "768P",
    "video": { "model": "minimax/minimax-h3", "mode": "video", "ratio": "9:16", "resolution": "768P", "duration": 8 }
  }
}
```

`recipe` is re-validated on read the way every other stored field is — a tab it cannot name means
there is nothing to replay, an unknown mode falls back to `free`, and a duration is clamped — because
a wrong ratio on the next call is a paid 400.

**Reuse** puts the panel back exactly as it was: the tab, the typed prompt, the canvas image or the
clip model, mode, ratio, size and duration, the enhancer, and the reference stills (fetched from
their render paths and re-prepped at 1 MP, so the next call sends the same images rather than a path
it cannot use). The rewrite is deliberately *not* restored into the prompt box: re-sending it would
pay to enhance an enhancement. A reference clip itself is not stored — only its rewrite — so that
mode comes back with a notice to re-attach the clip.

The tab follows the **media**, not the recipe: a frame saved before recipes existed is still a clip,
so it opens on the Video tab with the model and length it recorded on itself, and only falls back to
Create for a still. A recipe it cannot use is ignored rather than guessed at.

Fitting deliberately accounts for the chrome: on desktop the work is framed to the right of the
left rail, on mobile to the strip above the bottom sheet. Resizing or rotating re-frames.

## Video

The `Video` tab renders clips with **`minimax/minimax-h3`** through the same Router credential. The
Style row is replaced by a **Mode** selector:

| Mode | What it sends |
| --- | --- |
| Free | The text prompt, plus optional **first** and **last** frame images as `image_url` items with `role: first_frame` / `last_frame`. |
| Audio Reference | The clip goes to the rewrite model; H3 receives the six-section prompt it writes. |
| Video Reference | The clip goes to the rewrite model; H3 receives the six-section prompt it writes. |

### References are rewritten, always

An audio or video reference is not a prompt the way a typed sentence is: the model gets a clip plus a
sentence and has to infer the shot. Those two modes are therefore not optional — the **Flavor**
button is not shown, the panel sends no `brain` of its own, and `POST /api/video` ignores one if a
stale client sends it anyway. Nothing on the panel names the model: which LLM formats the prompt is
an account detail, not a directing decision.

The model lives in the account instead: **top right → Manage account → Prompt model**, saved in
`.data/account.json` beside the key as `brain` and `thinking`. The default is
`anthropic/claude-opus-5-5` at **medium** thinking. The route resolves it server-side with
`referencePrompt()`, so the panel, the route and the account cannot disagree, and a saved id that is
no longer in the allowlist (or a thinking level nobody sent) falls back to the default rather than
failing a render.

Thinking is sent in each provider's own shape — `thinking: { type: "enabled", budget_tokens }` on
Anthropic, with `max_tokens` pushed above the budget so the body is legal, and
`reasoning: { effort }` on OpenAI. A model with no reasoning knob (GPT-4.1) is never handed one.

### Three tiers, one card

H3 ships as three Router models, and the picker's H3 card carries a segmented **Original / Max /
Turbo** toggle instead of three list rows. The card's note describes whichever tier is selected, and
the tier is what the panel sends as `model`.

| Tier | Model | Contract |
| --- | --- | --- |
| Original | `minimax/minimax-h3` | `content[]` of typed items — text, keyframes, character, background, audio, clip — answered with a task at `task.content.url`. |
| Max | `fal/h3-max` | One flat body: `prompt`, `aspect_ratio`, `duration`, `prompt_expansion_mode`, `resolution`. Answered with `video.url`. |
| Turbo | `fal/h3-max-turbo` | The same flat body, tuned for speed. |

They are not interchangeable: a `content[]` body sent to a fal model is a 422 and vice versa, so
`buildVideoRequest(input, api)` and `videoResultUrl(data, api)` take the model's `api` and switch on
it. Max and Turbo have no reference fields at all, so they run **Free mode only** — the panel hides
the In/Out tiles and the character and background slots for them, and switching to one clears the
references it could not carry. Both also require `prompt_expansion_mode`; the studio asks for
`quality` when its own rewrite did not run and `balanced` when it did, so the prompt is not expanded
twice.

Fal's ratios are `16:9`, `1:1` and `9:16` — no `3:4`, `4:3` or `adaptive` — so each model declares
its `ratios` and the ratio picker only renders those, clamping a stale choice to the tier's default
rather than paying for a 422.

Free mode shows two compact upload tiles side by side — `In` and `Out`, half the panel width each —
using the same row styling as the audio and video inputs, so they cost one line of height instead of
two. Every media tile on this panel opens the same asset picker as the Create tab, so a still already
on the canvas can become a keyframe. They are optional and independent: one, both or neither.
A filled tile carries a `✕` on its right edge. The tile itself still opens the picker, so the ✕ is
the only way out and the tile is the way back in: clicking one *replaces* the reference, clicking the
other removes it — the same for the audio and video reference slots below. Router
treats keyframe roles and `reference_*` roles as mutually exclusive in a single request, so a keyframe
wins over character and background images; the character slots dim while a keyframe is set rather
than silently doing nothing.
Once an audio or video reference is attached, a **Trim** button appears beside the row showing the
current clip length. It opens a preview with a draggable window over the media: a waveform for audio,
the clip itself for video, where dragging an edge seeks the player to that frame so you can see what
you are selecting. Attaching a new reference seeds that length from the file's own duration, clamped
to the model's range, so a 16s clip starts at 15s and a 3s clip starts at the 5s floor. When the
reference is shorter than the floor, the dialog says what will actually be requested.

Every number in that dialog is **whole seconds** — `0s → 12s`, `12s` — never frames and never
fractions. Drags are snapped by `snapWindow()`, so a sloppy handle release can't land on `14.1s`;
the window is clamped inside the media and inside the model's range. The floor is the model's own
minimum, **5s** for H3, so you cannot trim a selection shorter than that — dragging the handle in
stops at five. A reference shorter than the floor is used whole rather than padded.

- **Audio** is genuinely cut: decoded with WebAudio, sliced to the selection, re-encoded as 16-bit
  PCM WAV, and that trimmed file is what gets uploaded.
- **Video** in this output-length dialog is not cut: the whole stored clip is sent and the selection
  sets the output length. To actually cut a clip, use the **Edit clip** panel when uploading it.
- The window never exceeds the model's ceiling (H3: 5–15s), and `duration` is what the route
  validates.

Aspect ratio is a chip in the video panel: clicking it opens a grid of shapes. H3 accepts five —
`3:4`, `9:16`, `4:3`, `16:9` and `1:1` — plus **Auto**, and the choice is sent as `ratio`. **Auto** is
H3's `adaptive`: let the reference media decide the framing. Router passes it through when reference
media is present and turns it into `16:9` for a text-only render (a shape is required there); a local
render always resolves it to `16:9`, since the graph needs concrete width and height. A local render
maps every id to a 32-pixel-grid size near 1344×768 (`localDimensions`), so a portrait clip is not
four times the cost of a landscape one.

**Resolution** is a picker too, and it lists what the selected entry actually takes. Original H3
accepts exactly two values — `768P` (shown as `1k`, 1344×768 at 16:9) and `2K` — and anything else
comes back as a paid 400, so those are the only two it offers; `480P` is not one of them. Max and
Turbo take `480p` and `1k`, since that is what the fal schema names, and no `2K`. The local entry
offers `480p` and `1k` as well, because its graph carries a dimension table for each (`864×480` at
16:9, `480×864` at 9:16, still on the 32-pixel grid) and 2K on local hardware is several times the
work. Switching models or tiers resets the choice to that entry's default, and the route clamps
whatever a stale client sends back inside the entry's own set.

**Duration** is the third picker, listing every whole second the model renders (5–15s). Reference
modes take that control back, because the media decides: an **Audio Reference** sets the clip length
(uploading or trimming it updates the duration), and a **Video Reference** sets both length and
framing. The locked chip shows a padlock and cannot be opened — edit the reference's trim window
instead.

If a browser cannot decode the file for preview (some Electron builds refuse WebM), the dialog says
so and offers **Keep Ns** rather than trapping you with a disabled button.

Character and background images on the Video tab become `image_url` items with
`role: reference_image`, so a clip can use the same cast as a still. The Create tab has its own
up-to-four reference slots, stored separately on the frame.

**Before a video joins the library**, the picker opens an **Edit clip** panel. It shows the trim
window with tenth-of-a-second handles, crop presets (Original, 16:9, 9:16, 1:1), and a zoom plus
drag control for reframing. Leaving the clip untouched adds the original file unchanged; trimming or
cropping redraws the selection onto a canvas at up to 1280px and records it with MediaRecorder in
real time (a 7s window takes 7s). Once added, audio and video references are sent as data URIs
exactly as stored. Re-encoding still degrades motion, which is why the panel defaults to untouched.

H3 takes a list of typed content items rather than flat fields, and `buildVideoRequest()` assembles
it in the order the model expects: one text item, then the mode's media, then the images. Duration is
clamped to the provider's 4–15s window and resolution is canonicalised to `480P`/`768P`. The finished
MP4 is at `task.content.url`, which Router re-hosts for twelve hours, so the route downloads and
stores it locally before returning — the canvas then plays it from disk.

**MiniMax H3 Local** is the same model on your own machine, and it does not go through Router at
all. `lib/local-video.ts` builds the core-node H3 graph (`UNETLoader` + `CLIPLoader` + the video and
audio VAEs → `MiniMaxH3ReferenceToVideo` → sampler → decode → `SaveVideo`), submits it, and reads
the MP4 back off the `SaveVideo` node. Point `COMFY_BASE_URL` at your ComfyUI and the entry works
with no key and no credits. A hosted **deployment** is the exception: `dep-….run.comfy.app`
answers an anonymous `POST /api/v2/jobs` with 401, so the key from Manage account (or
`COMFY_API_KEY`) is sent with the render — it is the same Comfy credential, never Router's bill.
Image and audio references are `LoadImage` / `LoadAudio` nodes; a motion reference is a core
`LoadVideo` node split by `GetVideoComponents`, whose frames go to `ref_videos.ref_video_0` (that
input is typed `IMAGE`, not `VIDEO`). First/last frames stay
Router-only, because the local graph has no keyframe role.

**The finished clip keeps the reference's own sound.** In Audio Reference mode the uploaded track is
the finished mix, so it is muxed straight into `CreateVideo`; in Video Reference mode the reference
clip's audio is carried through the same `GetVideoComponents` node. H3's own audio latents are
decoded (`VAEDecodeAudio`) only for a free render, or when the motion reference is silent — a
reference that already has sound is never replaced by a regenerated bed.

**Continue** extends a clip instead of referencing one. The canvas bar's Continue button (and the
viewer's) restores that clip's prompt, model and timing, drops the clip into the video-reference
slot, and adds a fourth tab — *Continue*, in orange rather than the studio's lime — to the mode
toggle. Choosing any other tab takes the tab away, because a continuation is a render of that clip
and cannot outlive the decision to stop continuing it.

One clip is then read two ways. The prompt model watches all of it and is asked, verbatim:

```
Create a {duration}s video prompt that runs after the provided clip.
Extra details: {the typed prompt}
```

H3 sees only the run-up to the cut: `GetVideoComponents` splits the clip and `ImageFromBatch` reads
its last 22 frames (`batch_index: -22, allow_negative_index: true`, so the graph never has to know
the clip's length). Router takes a clip, never a time range, so a continuation render on Router cuts
those same 22 frames in the panel first — the canvas-and-MediaRecorder path the pre-upload editor
already uses — and sends the tail as `reference_video` beside the whole clip, one for each model.

That endpoint can be either shape. A **deployment** (or `comfy-api-proxy`) speaks API v2 and is
driven through the Comfy SDK. A **bare ComfyUI** is detected with one probe — `GET /api/v2/jobs`
answers 404 there, and its static-file fallback answers a v2 POST with 405 — and the same graph is
then submitted the classic way: `POST /upload/image`, `POST /prompt`, poll `GET /history/<id>`, then
`GET /view` for the file. So `http://192.168.0.10:8188` works as-is, with no proxy in between.

The row for it in the model picker has a small **gear**: it opens a dialog for the diffusion model
name, the clip model name and the step count (defaults: `fasth3_omniref_8step_pruned_int8_convrot`,
`qwen3vl_32b_minimax_h3_nvfp4_awq`, 8 steps). Those three are kept in this browser and
used to build the graph; the VAEs stay environment-driven (`H3_VAE_VIDEO` / `H3_VAE_AUDIO`), and
`H3_CLIP` / `H3_STEPS` only fill gaps while nothing has been saved.

The dialog's **Verify** asks the active target for `/object_info/UNETLoader` and
`/object_info/CLIPLoader` and reports whether each configured name exists there. ComfyUI behind
`comfy-api-proxy` answers those; a hosted deployment only serves `/api/v2/...`, so there Verify
submits a throwaway job with an impossible file name and reads the accepted names out of ComfyUI's
own `not in [...]` reply (`lib/model-lists.ts`). Nothing executes — validation fails before the
first node runs — but each probe does leave one failed job in the deployment's history.

**FLUX 3 Local** is the image counterpart. The Create tab's model row opens the same kind of
picker, with FLUX 3 on Router and FLUX 3 Local side by side. `lib/local-image.ts` builds the FLUX 3
Klein graph (`UNETLoader` + `CLIPLoader` with type `flux3` + `VAELoader` → `CLIPTextEncode` →
`ConditioningZeroOut` → `EmptyFlux2LatentImage` → `KSampler` → `VAEDecode` → `SaveImage`), submits
it to the same endpoint, and reads the PNG back. Canvas mode uses the provider's
`image_flux3_klein_image_edit` shape instead: `LoadImage` for the canvas → `ReferenceMultiLatent`
(`resolution: "resize"` at the selected size class, with the canvas as `images.image0`) → `KSampler`
→ `VAEDecode` → `SaveImage`; the output keeps the canvas image's aspect ratio. `images` is a dynamic
input on that node, so the panel's reference stills follow the canvas as `images.image1…3` — and
only in Edit mode, because the text-to-image graph has nowhere to put them. Editing uses
whichever UNET the gear names; the provider's sample uses
`flux3-image-klein-base-int8-convrot.safetensors` at 50 steps, while the default here stays the
distilled file at 20. Non-canvas local renders are text-to-image, so the reference slots are cleared
when the local tool is selected. Its gear covers the diffusion model, the Qwen3-VL text encoder and
the step count (defaults `flux3-image-klein-int8-convrot0.safetensors`,
`qwen3vl_4b_fp8_scaled.safetensors`, 20 steps, kept in this browser); `FLUX_VAE`
stays environment-driven (`flux2-vae.safetensors` by default), and `FLUX_UNET` / `FLUX_CLIP` /
`FLUX_STEPS` only fill gaps while nothing has been saved. Verify checks `/object_info/UNETLoader`
and `/object_info/CLIPLoader`.

Clips land on the canvas as frames, marked with a play badge; `<video muted loop playsInline>` keeps
them running without a click.

## Answer or render?

One prompt goes to a **brain** — a Router text model (`anthropic/claude-haiku-4-5-20251001` by
default) — which returns strict JSON:

```json
{ "intent": "image", "image_prompt": "A lighthouse on a storm-battered cliff at dusk…" }
{ "intent": "answer", "answer": "Blue light scatters more than red, so the sky reads blue." }
```

- **answer** → the text becomes a chat bubble. No image model is called.
- **image** → the brain's rewritten prompt goes to `bfl/flux-3-image` at the selected ratio and
  size class (1:1 / 1k by default), and the bytes are written to disk. A batch of two to four is
  that many calls, and every returned `src` becomes its own frame.

**Edit** (the switch in the FLUX 3 row) turns the still into an edit. With it on, an image media
slot appears below the row, the ratio chip locks to `Auto` (Router follows image 1; the local graph
resizes the canvas image), and Flavor is hidden so the typed instruction reaches the model verbatim.
The canvas image is sent as image 1; reference images follow as image 2…

Every reply also carries the reason it took that branch. If the brain cannot run (no key, provider
outage, unparseable reply) a deterministic local router takes over so the app still answers
questions about itself and still renders.

Prompt assembly is one pure function, so what gets sent is inspectable:

```ts
composePrompt("A fox in snow", "", { references: 2 });
// "A fox in snow.
//  Use images 1-2 as references: keep each subject, its appearance and the setting consistent with them."

composePrompt("Change the dress to red", "", { canvas: true, references: 2 });
// "Change the dress to red. Image 1 is the image to edit.
//  Images 2-3 are references: keep each subject, its appearance and the setting consistent with them."
```

## Prompt controls

The prompt box has two controls in its footer, matching the Comfy app bar.

**Flavor** — a button, not a switch. It shows the enhancer in force and opens a picker listing `Off`
plus the models it can write with:

| Model | Provider | When to pick it |
| --- | --- | --- |
| Claude Opus 5.5 | anthropic | The strongest writer in the list. |
| Claude Fable 5.1 | anthropic | The most vivid, storytelling rewrite. |
| Astra 6 | vertexai | Google's newest writer; it reads clips too. |
| GPT-6 | openai | Precise, literal rewrites. |
| GPT Luna 6 | openai | Fast and cheap, OpenAI's lighter 6. |

Flavor is deliberately not the reference model: it never sees a clip, so it stays on the strongest
writer rather than the one with eyes for video (see
[References are rewritten, always](#references-are-rewritten-always)).

The button is the quick toggle for stills and Free-mode clips. It starts **Off** for a new
visitor, and a saved choice is restored on the next visit. Audio and video reference clips do
not use it — they are always rewritten, by the model set in **Manage account** (see
[References are rewritten, always](#references-are-rewritten-always)).

On, the enhancer's rewrite becomes the image prompt, so a four-word idea arrives at FLUX as a full
scene description. **Off**, your typed text is sent verbatim and the model
is only used to decide *answer vs render*. The toggle is a contract, not a hint: `pickSubject()`
ignores the rewrite when it is off, and the request carries `enhance: false` with no `brain` field.
Either way the exact string sent is what the frame records and what the transcript shows, prefixed
`Enhanced prompt:` or `Rendered:`.

`BRAIN_OPTIONS` is still an allowlist on both sides, so `resolveBrain()` rejects anything outside it
with a 400 rather than forwarding an id to Router that no adapter can build a body for. The picker
offers exactly one of them — Opus 5.5 — while the rest stay callable by name from the account's
prompt-model spec, and a `cinematic.brain` value from an older session that names another model is
ignored rather than shown as an unchecked row.

**Reference images** — up to four dashed slots on Create, used for anything: characters, objects, a
place or a look. One slot is always offered; fill it and another appears, up to four. Clicking a slot
opens the **asset panel** instead of the OS file dialog: it lists what you uploaded this session
plus every still and clip already on the canvas, filtered to stills, with **Recent**, **All** and a
starred **Saved** shelf. Choosing an existing render reuses it without a detour through your
downloads folder. Anything you pick is redrawn in the browser so that its **total pixels never
exceed 1 MP** (a 1024² render becomes 1000×1000); a 12 MP phone photo lands at ~1 MP too. That is
`fitWithinPixels()`, so a wide image keeps its aspect ratio instead of being cropped to a square.

Pick PNG/JPEG/WebP files and they are sent as FLUX reference images (`images: [<base64>, …]`) with
this appended to the prompt:

> Use images 1-3 as references: keep each subject, its appearance and the setting consistent with them.

The images are saved beside the render (`referenceSrcs`), so the frame carries one badge (and the
viewer names the count) and Reuse puts them back in the slots. The Video tab still uses separate
character and background slots for H3; those share the asset library, not these Create slots.

That wiring works end to end: attaching a fox render as the reference and asking for "the fox standing
outside a storm-lit lighthouse" returns a fox in a trench coat on storm-washed rocks below a
lighthouse beamed by lightning.

## Persistence

Everything you make lives in **this browser**. There is no database and no
server-side store, so nothing you render is visible to anyone else and the host
keeps nothing:

```
IndexedDB "comfy-cinematic"
  projects   one record per project: name, frames (src + position), chat, library
  media      one blob per still, clip or track
localStorage "cinematic.settings"
  the Comfy key, render targets, prompt model, local model names
```

A frame or asset `src` is `media:<uuid>.<ext>` — a pointer into the media store,
resolved to an object URL for the page. The old `/api/renders/<id>` shape is
still accepted, so a project from an older build opens.

The whole document is re-validated on the way in:

- Project ids must match a strict pattern, so a URL cannot address another record.
- A media `src` must be `media:<id>.<ext>` — remote URLs and inline `data:` blobs are rejected.
- Frames are capped at 48, messages at 200, prompts at 900 characters.

Saving is debounced (600 ms) and the header shows `saving` / `saved` / `unsaved`.
The browser is asked for persistent storage on every save, so it does not evict a
library under pressure.

Clearing this site's data deletes your projects. Treat the browser as the only
copy; export/import is the planned answer.

### Hosting it for other people

The server is stateless, so any Node host works — but reads and writes are
per-visitor, and that is the point:

- Set `PUBLIC_HOSTING=1`. The host's own `COMFY_API_KEY` and
  `COMFY_LOCAL_API_KEY` are then never lent to visitors, and a render target
  must resolve to a public address (`isAllowedEndpoint`) or it is refused.
- Do not set `COMFY_API_KEY` on a public host.
- "Comfy Desktop" means the *server's* `127.0.0.1`, not the visitor's, so point
  visitors at a hosted deployment (or a tunnel to their own ComfyUI) instead.
- Let the platform run long requests: an image render is bounded at 300 s and a
  clip at 840 s.


## Run it

1. Node 22.6+ and a [Comfy API key](https://platform.comfy.org/profile/api-keys?onboarding=router)
   for a workspace with Router access and credits.
2. Install and configure:

   ```sh
   npm ci
   cp .env.example .env.local
   # put the key in COMFY_API_KEY
   npm run dev
   ```

3. Open <http://127.0.0.1:3000>, press **New project**, describe something.

### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `COMFY_API_KEY` | — | Router credential for a self-hosted studio. A key entered in the header's **Sign in** wins over this one, and `PUBLIC_HOSTING=1` stops it being lent to visitors entirely. |
| `HARNESS_MODEL` | `anthropic/claude-haiku-4-5-20251001` | Default when the picker sends nothing. Must be an `anthropic/*` or `openai/*` model. |
| `COMFY_ROUTER_BASE_URL` | `https://api.comfy.org` | Point at a compatible Router endpoint. |
| `COMFY_BASE_URL` | — | Overrides both render targets from Manage account (e.g. `http://127.0.0.1:8189`). |
| `COMFY_LOCAL_API_KEY` | — | Only for a local ComfyUI that sits behind auth; Router's key is never sent there. A hosted deployment uses the visitor's own key instead. |
| `H3_CLIP` / `H3_STEPS` | — | Fill the clip name and steps only while no configuration has been saved from the gear. |
| `H3_VAE_VIDEO` / `H3_VAE_AUDIO` | Comfy-Org H3 file names | The two VAEs, which the dialog does not cover. |
| `FLUX_UNET` / `FLUX_CLIP` / `FLUX_STEPS` | — | Fill the local FLUX 3 model, text encoder and steps only while no configuration has been saved from the gear. |
| `FLUX_VAE` | `flux2-vae.safetensors` | The VAE, which the dialog does not cover. |
| `PUBLIC_HOSTING` | — | Set to `1` on a shared deployment: the host's own keys are not lent out, and render targets must resolve to public addresses. |

The image tool registry (Router and local), ratio and resolution live in `lib/harness.ts`, so the UI
and the route can never disagree about what the tool is.

### Signing in

The top-right pill is the account control. Signed out it reads **Sign in** and opens a form for a
Comfy Router key; the key is checked against `cloud.comfy.org/api/billing/balance`, then kept in
this browser's `localStorage`. Signed in it shows the workspace's credit count — 211 credits
to the dollar, the same rate comfy.org's header uses — tinted red when the balance runs low, and its
menu holds **Manage account** (balance, the active render target, and a refresh — the key is not editable there; to change it,
sign out and back in) and
**Sign out**.

The key never leaves this browser: `GET /api/account` is sent the key in a header, and answers
with a masked tail (`••••wxyz`) and a credit count, nothing else. Router calls use the visitor's
key; a self-hosted studio falls back to `COMFY_API_KEY`,
so the header changes who pays without editing `.env.local`.

The same dialog is the **Manage account** screen once you are signed in, with two addresses to choose
between for **workflow renders** (nothing else uses them):

- **Deployment** — a hosted Comfy build, `https://dep-….run.comfy.app`.
- **Comfy Desktop** — your own ComfyUI, either directly (`http://127.0.0.1:8188`) or behind
  `comfy-api-proxy`.

Both are where `lib/local-video.ts` submits the graph; it probes the address and speaks API v2 when
that is what the target serves, classic ComfyUI routes when it is not. Each target keeps its own
address, so switching is one radio click. **Setting `COMFY_BASE_URL`
overrides both**: the dialog then shows *Set via environment* and the two options are disabled. With
no address from either source, a workflow render answers 503. The account card shows the active one.

On a public host (`PUBLIC_HOSTING=1`) a **Desktop** address is the server's own loopback, not the
visitor's machine, and a target that resolves to a private address is refused — visitors use a
deployment, or a tunnel to their own ComfyUI.

## Costs

- Every prompt is one text call (the brain). Answers cost only that.
- Every render adds one FLUX 3 call per image at the selected size class, billed to the workspace behind `COMFY_API_KEY`.
- The local fallback path is free and only runs when the brain is unavailable.

## Tests

```sh
npm test      # node:test cases + tsc --noEmit
npm run build
```

Covered: brain request/response adapters for both providers, the model allowlist, decision parsing
(fenced, chatty, malformed), image-prompt capping, local fallback routing, the tool registry
contract, prompt composition (subject + reference + canvas), the flavor toggle, the
1 MP reference cap, frame grid placement, viewport bounds, source-path validation, document
normalization and caps, summaries, style phrases and relative times.

## Layout of the code

```
app/
  page.tsx                    projects grid
  p/[id]/page.tsx             workspace shell
  api/account/route.ts        check a key + read its balance
  api/harness/route.ts        brain → answer | render, returns the bytes
  api/video/route.ts          one prompt → clip, returns the bytes
components/
  projects-home.tsx           grid, cards, empty state
  project-workspace.tsx       canvas, panel, dock, history, autosave
lib/
  projects.ts                 model, validation, grid math (pure)
  browser-db.ts               IndexedDB open + record helpers
  browser-projects.ts         projects, kept in this browser
  browser-media.ts            blobs, `media:` sources, object URLs
  client-settings.ts          the key/settings envelope + `apiFetch`
  studio-settings.ts          the `x-comfy-studio` header codec (pure)
  brain.ts                    text-model adapters + decision parsing
  harness.ts                  tool registry + deterministic fallback
  flux-output.ts              Router result-envelope reader
```

## Limits

- One image tool, one ratio, one resolution. No editing, inpainting, references, video or audio.
- Renders are independent; there is no seed or continuity between frames.
- The brain must be an `anthropic/*` or `openai/*` Router text model — add an adapter for others.
- Projects are local to this browser, not synced anywhere.
- Deleting a frame leaves its blob in the media store; deleting the project removes the media it
  still references. Clearing this site's data removes everything.

## License

MIT. See [`LICENSE`](LICENSE).
