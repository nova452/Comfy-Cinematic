"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AccountMenu } from "./account-menu";
import { ChipPicker } from "./chip-picker";
import { ModelLogo } from "./model-logo";
import { AssetPicker, type PickedAsset } from "./asset-picker";
import { AssetLibrary } from "./asset-library";
import { addUpload, renderAsset, toggleLiked, type Asset, type AssetKind } from "../lib/assets";
import type { MediaFile, Reference } from "../lib/client-image";
import { dataUrlFromBlob, mediaFromSrc, prepareReference } from "../lib/client-image";
import {
  apiFetch,
  onSettingsChange,
  readSettings,
  rememberLocalModel,
} from "../lib/client-settings";
import { deleteProject as forgetProject, readProject, writeProject } from "../lib/browser-projects";
import { getMediaBlob, mediaUrl, putDataUrl, putJpeg, putMedia, useMediaVersion } from "../lib/browser-media";
import { recordTail } from "../lib/record-video";
import { TrimModal } from "./trim-modal";
import { ShareModal } from "./share-modal";
import { LocalImageConfigDialog } from "./local-image-config";
import { BRAIN_OPTIONS, FLAVOR_BRAINS, isFlavorId, type BrainOption } from "../lib/brain";
import {
  DEFAULT_IMAGE_BATCH,
  DEFAULT_TOOL,
  MAX_IMAGE_REFERENCES,
  TOOLS,
  clampImageBatch,
  findImageRatio,
  findImageResolution,
  findImageTool,
  imageBatchOptions,
  imageRatioLabel,
  imageRatioOptions,
  imageResolutionLabel,
  imageResolutionOptions,
  isMissingModelError,
  type ImageResolution,
} from "../lib/harness";
import {
  CONTINUATION_FRAMES,
  DEFAULT_VIDEO_MODEL,
  MAX_VIDEO_IMAGES,
  VIDEO_MODES,
  VIDEO_RATIOS,
  VIDEO_RESOLUTIONS,
  clampDuration,
  durationOptions,
  findVideoModel,
  findVideoRatio,
  findVideoResolution,
  h3TierModels,
  LOCAL_MODEL_DEFAULTS,
  REF_VIDEO_EDGES,
  localModelConfig,
  lockedByMode,
  ratioOptions,
  resolutionOptions,
  standaloneVideoModels,
  videoModeLabel,
  videoRatioLabel,
  videoResolutionLabel,
  type LocalModelConfig,
  type VideoMode,
  type VideoModel,
  type VideoResolution,
} from "../lib/video";
import type { StudioPlan } from "../lib/studio";
import {
  FRAME_SIZE,
  MAX_FRAMES,
  clipSeconds,
  frameBounds,
  isVideoSrc,
  nextPosition,
  normalizeName,
  relativeTime,
  type Frame,
  type FrameRecipe,
  type Message,
  type Project,
} from "../lib/projects";
import {
  readPanelSettings,
  writePanelSettings,
  type PanelTab,
} from "../lib/panel-settings";

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 2;
const SAVE_DELAY = 600;
const BRAIN_KEY = "cinematic.brain";

/** The enhancers the Flavor picker lists, in the order `FLAVOR_BRAINS` sets. */
const FLAVOR_MODELS = FLAVOR_BRAINS.map((id) =>
  BRAIN_OPTIONS.find((option) => option.id === id),
).filter((option): option is BrainOption => Boolean(option));
const MAX_CHARACTERS = 3;

/** `anthropic/claude-opus-5-5` → `Opus 5.5`, for the viewer's settings row. */
function flavorLabel(id: string) {
  return BRAIN_OPTIONS.find((option) => option.id === id)?.short ?? id;
}

/**
 * A stored mode or size as the label the panel uses.
 *
 * Recipes are untrusted JSON and a project can outlive a model, so an id this
 * build no longer offers is shown as itself rather than as nothing.
 */
function modeLabel(id: string) {
  return VIDEO_MODES.find((mode) => mode.id === id)?.label ?? id;
}

function resolutionLabel(id: string) {
  return VIDEO_RESOLUTIONS.find((option) => option.id === id)?.label ?? id;
}

/** How many generic reference images a frame used. */
function referenceCount(frame: { referenceSrc?: string; referenceSrcs?: string[] }) {
  return frame.referenceSrcs?.length ?? (frame.referenceSrc ? 1 : 0);
}

/**
 * The clip settings a reuse wants back.
 *
 * Every field but `model` is optional: frames made before recipes existed still
 * record their model and length, and a reuse restores exactly what it knows.
 */
type ClipRestore = {
  model: string;
  mode?: string;
  ratio?: string;
  resolution?: string;
  duration?: number;
};

/**
 * A saved reference render, back as something the panel can send again.
 *
 * References are stored as render paths, not as the JPEG that was uploaded, so
 * a reuse has to fetch the file and run it through the same 1 MP prep the asset
 * picker uses — otherwise a reused call would quietly send a different image.
 */
async function referenceFromSrc(src: string): Promise<Reference | undefined> {
  try {
    const blob = await getMediaBlob(src);
    if (!blob) return undefined;
    const name = src.split("/").pop() || "reference.jpg";
    const type = blob.type.startsWith("image/") ? blob.type : "image/jpeg";
    return await prepareReference(new File([blob], name, { type }));
  } catch {
    return undefined;
  }
}

type View = { x: number; y: number; zoom: number };
type Tool = "select" | "hand";
type Snapshot = { frames: Frame[]; messages: Message[] };
type SaveState = "idle" | "saving" | "saved" | "error";
/**
 * A render that is in flight, holding its slot on the canvas.
 *
 * The slot is picked before the request goes out, so the work lands in its own
 * space and a second render cannot claim it while this one is still running.
 */
type PendingRender = { id: string; x: number; y: number; kind: "image" | "video"; prompt: string };

/** What `/api/video/progress` says about one clip in flight. */
type RenderTrack = { label: string; stage: string; step?: number; steps?: number; elapsed: number };

/** How far up the tile's fill sits for a report, or undefined to keep the timed climb. */
function trackFraction(track: RenderTrack | undefined) {
  if (!track) return undefined;
  if (track.stage === "downloading") return 0.96;
  // Sampling is nearly all of a local clip's time, so the steps carry the bar.
  if (track.step !== undefined && track.steps) return 0.06 + 0.88 * Math.min(1, track.step / track.steps);
  if (track.stage === "rewriting" || track.stage === "uploading" || track.stage === "queued") return 0.03;
  return undefined;
}

/** `m:ss` for a tile, which has room for little else. */
function clock(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * A drag position waiting for the next animation frame.
 *
 * `pointermove` is a continuous event: React batches a burst of them into one
 * flush, so scheduling a state update per event makes the update depth climb
 * with the speed of the pointer — and past fifty React gives up with "maximum
 * update depth exceeded". One update per frame is also the most a screen can
 * show, so nothing is lost by coalescing.
 */
type MoveTarget =
  | { mode: "pan"; x: number; y: number }
  | { mode: "frame"; id: string; x: number; y: number }
  | { mode: "pending"; id: string; x: number; y: number };

/**
 * Renders in flight, held outside React.
 *
 * `pending` state dies with the workspace component, but a render does not die
 * with the page that started it: leaving for the projects grid and coming back
 * must still show the slot — and still land the finished frame. The map is
 * keyed by project id; the workspace seeds its slots from it on mount, and the
 * render paths keep it current as slots are claimed, dragged and released.
 */
const inFlightRenders = new Map<string, PendingRender[]>();

/** Add slots a render just claimed to the surviving copy. */
function claimInFlight(projectId: string, slots: PendingRender[]) {
  inFlightRenders.set(projectId, [...(inFlightRenders.get(projectId) ?? []), ...slots]);
}

/** Drop slots a render finished with — successfully or not — from the copy. */
function releaseInFlight(projectId: string, ids: string[]) {
  const remaining = inFlightRenders.get(projectId)?.filter((slot) => !ids.includes(slot.id));
  if (remaining?.length) inFlightRenders.set(projectId, remaining);
  else inFlightRenders.delete(projectId);
  forgetClips(ids);
}

/** Everything a clip's frame records besides what the server answers. */
type ClipMeta = {
  /** What the person typed; may be empty in a reference mode. */
  value: string;
  caption: string;
  mode: VideoMode;
  model: string;
  ratio: string;
  resolution: VideoResolution;
  duration: number;
  brain: string | null;
  characterSrcs: string[];
  backgroundSrc?: string;
};

/** A clip in flight, as written to the browser so a reload can pick it up. */
type SavedClip = { projectId: string; slot: PendingRender; meta: ClipMeta; startedAt: number };

/**
 * Clips in flight, kept in `localStorage`.
 *
 * The registry above survives leaving the canvas but not a reload, and a
 * reload also throws away the request that would have brought the clip back.
 * The server keeps a finished clip under its tile id for a while, so writing
 * the tile down is enough: the next load finds it and collects the clip. A
 * still takes seconds and is not worth this; only clips are saved.
 */
const SAVED_CLIPS_KEY = "cinematic.inflight";
/** Past this the server has forgotten the render anyway. */
const SAVED_CLIP_TTL_MS = 30 * 60_000;

function readSavedClips(): SavedClip[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(SAVED_CLIPS_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return (parsed as SavedClip[]).filter(
      (clip) => clip && typeof clip.slot?.id === "string" && now - Number(clip.startedAt) < SAVED_CLIP_TTL_MS,
    );
  } catch {
    return [];
  }
}

function writeSavedClips(clips: SavedClip[]) {
  try {
    if (clips.length) window.localStorage.setItem(SAVED_CLIPS_KEY, JSON.stringify(clips));
    else window.localStorage.removeItem(SAVED_CLIPS_KEY);
  } catch {
    // Storage is full or blocked: the clip still lands unless the page reloads.
  }
}

function saveClip(clip: SavedClip) {
  writeSavedClips([...readSavedClips().filter((saved) => saved.slot.id !== clip.slot.id), clip]);
}

function forgetClips(ids: string[]) {
  const saved = readSavedClips();
  const kept = saved.filter((clip) => !ids.includes(clip.slot.id));
  if (kept.length !== saved.length) writeSavedClips(kept);
}

/** Saved clips being collected right now, so a remount never collects twice. */
const resumingClips = new Set<string>();

/** The frame a finished clip becomes, from the route's answer and its meta. */
async function clipFrame(
  id: string,
  data: { src: string; prompt?: string; sourcePrompt?: string; enhanced?: boolean; model?: string },
  meta: ClipMeta,
  at: { x: number; y: number },
): Promise<Frame> {
  const storedSrc = await putDataUrl(data.src, "clip.mp4");
  return {
    id,
    src: storedSrc,
    prompt: data.prompt?.trim() || meta.caption,
    // An empty prompt stays empty: the caption labels the frame, it is not
    // something the person typed, and a reuse must not hand it back as one.
    sourcePrompt: (data.sourcePrompt ?? meta.value).trim(),
    enhanced: data.enhanced === true,
    // A reference mode rewrites unconditionally, so it has no enhancer to
    // record; leaving the field out says "not applicable" rather than
    // "off", which would turn the button off for the user.
    recipe: {
      tab: "video",
      ...(meta.mode === "free" ? { flavor: meta.brain } : {}),
      ratio: meta.ratio,
      resolution: meta.resolution,
      video: {
        model: data.model ?? meta.model,
        mode: meta.mode,
        ratio: meta.ratio,
        resolution: meta.resolution,
        duration: meta.duration,
      },
    },
    characterSrcs: meta.characterSrcs,
    backgroundSrc: meta.backgroundSrc,
    media: "video",
    seconds: meta.duration,
    style: "none",
    model: data.model ?? meta.model,
    x: at.x,
    y: at.y,
    createdAt: Date.now(),
  };
}

/** The canvas log line for a finished clip. */
function clipMessage(meta: ClipMeta, frame: Frame): Message {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    text: meta.value
      ? `Clip · ${videoModeLabel(meta.mode)}: ${frame.prompt}`
      : `Clip · ${videoModeLabel(meta.mode)}`,
    createdAt: Date.now(),
  };
}

/** Which input asked for the asset picker. */
type PickerTarget =
  | { slot: "character"; index: number | null }
  | { slot: "background" }
  | { slot: "reference"; index: number | null }
  | { slot: "canvas" }
  | { slot: "first-frame" }
  | { slot: "last-frame" }
  | { slot: "audio" }
  | { slot: "clip" };

const PICKER_COPY: Record<PickerTarget["slot"], string> = {
  character: "Character reference",
  background: "Background reference",
  reference: "Reference image",
  canvas: "Canvas image",
  "first-frame": "First frame",
  "last-frame": "Last frame",
  audio: "Audio reference",
  clip: "Video reference",
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Capture the pointer, tolerating one that is no longer active.
 *
 * `setPointerCapture` throws `NotFoundError` when the id does not belong to a
 * live pointer: a touch cancelled between `pointerdown` and this call, a mouse
 * released in that gap, a synthetic press. That is not a reason to abandon the
 * drag — without capture it still tracks while the pointer stays over the
 * canvas — and letting the throw escape `pointerdown` would also skip the
 * `drag.current` assignment below it, so the gesture would do nothing at all.
 */
function capturePointer(element: Element, pointerId: number) {
  try {
    element.setPointerCapture(pointerId);
  } catch {
    // No capture; the drag proceeds anyway.
  }
}

type ToolsProps = {
  tool: Tool;
  onTool: (tool: Tool) => void;
  zoomLabel: string;
  onZoom: (factor: number) => void;
  onFit: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
};

/** Select / zoom / history. Rendered into the dock on desktop and the panel on mobile. */
function CanvasTools({
  tool,
  onTool,
  zoomLabel,
  onZoom,
  onFit,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
}: ToolsProps) {
  return (
    <>
      <div className="dock-group">
        <button
          type="button"
          className={tool === "select" ? "is-active" : ""}
          aria-pressed={tool === "select"}
          onClick={() => onTool("select")}
          title="Select"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9">
            <path d="M5 3l14 8-6 1.5L10 20z" />
          </svg>
        </button>
        <button
          type="button"
          className={tool === "hand" ? "is-active" : ""}
          aria-pressed={tool === "hand"}
          onClick={() => onTool("hand")}
          title="Pan"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7">
            <path d="M9 11V5.5a1.5 1.5 0 013 0V11M12 11V4.5a1.5 1.5 0 013 0V11M15 11V6.5a1.5 1.5 0 013 0V14c0 4-2.5 7-6.5 7S5 18 5 14v-3a1.5 1.5 0 013 0v2" />
          </svg>
        </button>
      </div>

      <div className="dock-group">
        <button type="button" onClick={() => onZoom(1 / 1.2)} title="Zoom out">
          −
        </button>
        <span className="dock-zoom">{zoomLabel}</span>
        <button type="button" onClick={() => onZoom(1.2)} title="Zoom in">
          +
        </button>
        <button type="button" onClick={onFit} title="Fit to view">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.9">
            <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
          </svg>
        </button>
      </div>

      <div className="dock-group">
        <button type="button" onClick={onUndo} disabled={!canUndo} title="Undo">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9">
            <path d="M9 7L4 12l5 5" />
            <path d="M4 12h9a5 5 0 010 10" />
          </svg>
        </button>
        <button type="button" onClick={onRedo} disabled={!canRedo} title="Redo">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9">
            <path d="M15 7l5 5-5 5" />
            <path d="M20 12h-9a5 5 0 000 10" />
          </svg>
        </button>
      </div>
    </>
  );
}

type ReferenceSlotProps = {
  kind: "character" | "background" | "reference";
  value?: Reference;
  disabled?: boolean;
  onChange: (value: Reference | undefined) => void;
  /** Opens the asset picker instead of the OS file dialog. */
  onPick: () => void;
};

const REFERENCE_GLYPH: Record<ReferenceSlotProps["kind"], React.ReactNode> = {
  character: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9">
      <circle cx="12" cy="8" r="4" />
      <path d="M20 21a8 8 0 0 0-16 0" />
    </svg>
  ),
  background: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9">
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <circle cx="8.5" cy="9.5" r="1.6" />
      <path d="M4 17l5-4 4 3 3-2 4 3" />
    </svg>
  ),
  reference: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9">
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M4 17l5-4 4 3 3-2 4 3" />
    </svg>
  ),
};

const REFERENCE_TITLE: Record<ReferenceSlotProps["kind"], string> = {
  character: "character",
  background: "background",
  reference: "reference",
};

/** One upload slot: empty shows a dashed tile, filled shows the image. */
function ReferenceSlot({ kind, value, disabled, onChange, onPick }: ReferenceSlotProps) {
  const noun = REFERENCE_TITLE[kind];
  const title = kind === "reference" ? "Add a reference image" : `Add a ${noun} reference`;
  const removeTitle = kind === "reference" ? "Remove reference image" : `Remove ${noun} reference`;

  if (value) {
    return (
      <button
        type="button"
        className={`reference-thumb is-${kind}`}
        onClick={() => onChange(undefined)}
        title={removeTitle}
        aria-label={removeTitle}
        disabled={disabled}
      >
        <img src={value.preview} alt="" />
        <span className="reference-kind" aria-hidden="true">
          {REFERENCE_GLYPH[kind]}
        </span>
        <span className="reference-x" aria-hidden="true">
          ✕
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      className="reference-add"
      title={title}
      data-kind={kind}
      disabled={disabled}
      onClick={onPick}
    >
      {REFERENCE_GLYPH[kind]}
      <span className="sr-only">{title}</span>
    </button>
  );
}

type MediaSlotProps = {
  tag: string;
  /** Shown in place of the filename while the slot is empty. */
  label: string;
  /** Names the thing being cleared: "Clear first frame". */
  noun: string;
  /** Right-hand mono hint — accepted formats when empty, size when full. */
  hint?: string;
  /** The compact In/Out tile instead of the full-width row. */
  compact?: boolean;
  value?: { name: string; mb: number };
  /** A frame of the attached file, painted behind the name. */
  preview?: string;
  /** Video previews are seeked to their first frame; images render as-is. */
  previewKind?: "image" | "video";
  /** The attached file itself, for the full-size view a filled slot opens. */
  viewSrc?: string;
  viewKind?: "image" | "video" | "audio";
  /** Set when a filled slot opens the full view instead of picking. */
  onView?: () => void;
  disabled?: boolean;
  onPick: () => void;
  onClear: () => void;
};

/**
 * One media slot. An empty tile picks a file; a filled tile opens the full
 * view, whose Replace button hands the slot back to the picker; the ✕ clears
 * it, so an attached reference is never a dead end. The clear button is a
 * sibling rather than nested markup — a button inside a button is not a thing.
 */
function MediaSlot({
  tag,
  label,
  noun,
  hint,
  compact,
  value,
  preview,
  previewKind,
  viewSrc,
  viewKind,
  onView,
  disabled,
  onPick,
  onClear,
}: MediaSlotProps) {
  const viewable = Boolean(value && onView && viewSrc);
  return (
    <div className="media-slot">
      <button
        type="button"
        className={`media-drop${compact ? " compact" : ""}${value ? " is-filled" : ""}${preview ? " has-preview" : ""}`}
        title={
          value
            ? `${value.name} · ${value.mb.toFixed(1)} MB${viewable ? " · click to view" : ""}`
            : label
        }
        disabled={disabled}
        onClick={viewable ? onView : onPick}
      >
        {preview && (
          <span className="media-preview" aria-hidden="true">
            {previewKind === "video" ? (
              <video
                src={preview}
                muted
                playsInline
                preload="metadata"
                onLoadedMetadata={(event) => {
                  // Metadata alone paints nothing; seek just past zero so the
                  // tile shows a real frame instead of a black rectangle.
                  const clip = event.currentTarget;
                  if (Number.isFinite(clip.duration) && clip.duration > 0) {
                    clip.currentTime = Math.min(0.1, clip.duration / 2);
                  }
                }}
              />
            ) : (
              <img src={preview} alt="" />
            )}
          </span>
        )}
        <span className="media-tag">{tag}</span>
        <span className="media-name">{value ? value.name : label}</span>
        {hint ? <span className="media-size">{hint}</span> : null}
      </button>

      {value ? (
        <button
          type="button"
          className="media-clear"
          title={`Clear ${noun}`}
          aria-label={`Clear ${noun}`}
          disabled={disabled}
          onClick={onClear}
        >
          ✕
        </button>
      ) : null}
    </div>
  );
}

export function ProjectWorkspace({ projectId }: { projectId: string }) {
  // Frames, tiles and previews re-render as their blobs come back from
  // IndexedDB; the first pass paints placeholders.
  useMediaVersion();
  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<string>();
  const [view, setView] = useState<View>({ x: 0, y: 0, zoom: 1 });
  const [tool, setTool] = useState<Tool>("select");
  const [tab, setTab] = useState<PanelTab>("create");
  const [prompt, setPrompt] = useState("");
  const [canvasEnabled, setCanvasEnabled] = useState(false);
  const [canvasImage, setCanvasImage] = useState<Reference>();
  const [imageModel, setImageModel] = useState<string>(DEFAULT_TOOL.id);
  const [imageModelOpen, setImageModelOpen] = useState(false);
  const [imageConfigOpen, setImageConfigOpen] = useState(false);
  /** Set when a failed render opened the dialog, so it verifies on its own. */
  const [imageConfigAutoVerify, setImageConfigAutoVerify] = useState(false);
  const [imageRatio, setImageRatio] = useState<string>(DEFAULT_TOOL.aspectRatio);
  const [imageResolution, setImageResolution] = useState<ImageResolution>(DEFAULT_TOOL.resolution);
  const [imageBatch, setImageBatch] = useState<number>(DEFAULT_IMAGE_BATCH);
  /** Flavor starts off; a saved choice, including Off, replaces it after mount. */
  const [brain, setBrain] = useState<string | null>(null);
  const [brainRestored, setBrainRestored] = useState(false);
  const [brainOpen, setBrainOpen] = useState(false);
  const [characters, setCharacters] = useState<Reference[]>([]);
  const [background, setBackground] = useState<Reference>();
  const [imageReferences, setImageReferences] = useState<Reference[]>([]);

  const [videoPrompt, setVideoPrompt] = useState("");
  const [videoModel, setVideoModel] = useState<string>(DEFAULT_VIDEO_MODEL.id);
  const [videoRatio, setVideoRatio] = useState<string>(DEFAULT_VIDEO_MODEL.ratio);
  const [videoResolution, setVideoResolution] = useState<VideoResolution>(DEFAULT_VIDEO_MODEL.resolution);
  const [videoModelOpen, setVideoModelOpen] = useState(false);
  const [videoDuration, setVideoDuration] = useState<number>(DEFAULT_VIDEO_MODEL.duration);
  const [trimOpen, setTrimOpen] = useState(false);
  const [videoMode, setVideoMode] = useState<VideoMode>("free");
  const [localConfig, setLocalConfig] = useState<LocalModelConfig | null>(null);
  const [localConfigOpen, setLocalConfigOpen] = useState(false);
  const [localDraft, setLocalDraft] = useState({ unet: "", clip: "", steps: "", refVideoEdge: "0" });
  const [localBusy, setLocalBusy] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{
    checked?: boolean;
    host?: string;
    unet?: { name: string; found?: boolean };
    clip?: { name: string; found?: boolean };
    note?: string;
    error?: string;
  } | null>(null);
  const [audioRef, setAudioRef] = useState<MediaFile>();
  const [clipRef, setClipRef] = useState<MediaFile>();
  /**
   * The clip a Continue was armed from.
   *
   * Its presence is what puts the Continue tab in the toggle, and choosing any
   * other tab is what takes it away — a continuation is a render of that clip,
   * so it cannot outlive the choice to stop continuing it.
   */
  const [continuation, setContinuation] = useState<{ src: string }>();
  const [firstFrame, setFirstFrame] = useState<Reference>();
  const [lastFrame, setLastFrame] = useState<Reference>();
  const [picker, setPicker] = useState<PickerTarget | null>(null);
  const [uploads, setUploads] = useState<Asset[]>([]);
  const [liked, setLiked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  /** Renders in flight, each holding a slot on the canvas. */
  const [pending, setPending] = useState<PendingRender[]>([]);
  /** The same slots, readable from a callback that resolves after a render. */
  const pendingRef = useRef<PendingRender[]>([]);
  pendingRef.current = pending;
  /** Live stage and step for clips in flight, keyed by slot id. */
  const [tracks, setTracks] = useState<Record<string, RenderTrack>>({});
  /** False once the workspace unmounts, while its renders keep running. */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  /** The frame shown in the full-size viewer, if any. */
  const [viewer, setViewer] = useState<string | null>(null);
  /** An attached reference seen full size, with a way to replace it. */
  const [mediaView, setMediaView] = useState<{
    src: string;
    kind: "image" | "video" | "audio";
    name: string;
    mb?: number;
    onReplace?: () => void;
  } | null>(null);
  /** The frame whose Delete button is armed, waiting for the second click. */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [savedAt, setSavedAt] = useState<number>();
  /**
   * The open share sheet, holding the URL it was opened with.
   *
   * `window` cannot be read while rendering, so the link is captured on the
   * press that opened the sheet rather than derived from the location later.
   */
  const [share, setShare] = useState<{ url: string } | null>(null);
  const [past, setPast] = useState<Snapshot[]>([]);
  const [future, setFuture] = useState<Snapshot[]>([]);
  const [notice, setNotice] = useState<string>();
  const [chatDraft, setChatDraft] = useState("");
  /** The project whose stored panel has been applied; writes wait for it. */
  const [panelProject, setPanelProject] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(false);
  /** Clip settings a reuse is about to restore, so the model effect leaves them alone. */
  const pendingRestore = useRef<ClipRestore | null>(null);
  /** Still settings a saved panel is about to restore, so the image effect leaves them alone. */
  const restoreImage = useRef<{
    model: string;
    ratio?: string;
    resolution?: string;
    batch?: number;
  } | null>(null);
  /**
   * What Video Reference held before Continue took the panel over.
   *
   * The two are separate modes with separate inputs, so arming a continuation
   * parks the reference the person already had and leaving Continue hands it
   * back instead of leaking the continued clip into Video Reference.
   */
  const continuePrior = useRef<{
    clip?: MediaFile;
    prompt: string;
    characters: Reference[];
    background?: Reference;
  } | null>(null);

  const canvasRef = useRef<HTMLDivElement>(null);
  const selectionBarRef = useRef<HTMLDivElement>(null);
  /** Where the selection bar sits, in canvas pixels. Null until measured. */
  const [barPos, setBarPos] = useState<{ left: number; top: number } | null>(null);
  const deleteTimer = useRef(0);
  const viewRef = useRef<View>(view);
  const projectRef = useRef<Project | null>(null);
  const skipSave = useRef(true);
  const spaceHeld = useRef(false);
  const chatLogRef = useRef<HTMLDivElement>(null);
  /**
   * The last frame press, for spotting a double-click.
   *
   * The canvas takes pointer capture on press so a drag keeps tracking the
   * cursor, and that retargets the browser's own `dblclick` to the canvas —
   * so a second press on the same frame, inside the usual window, is the
   * signal instead.
   */
  const lastPress = useRef<{ id: string; at: number }>({ id: "", at: 0 });
  const drag = useRef<
    | { mode: "pan"; pointerId: number; startX: number; startY: number; originX: number; originY: number }
    | { mode: "frame"; pointerId: number; id: string; startX: number; startY: number; originX: number; originY: number; snapshot: Snapshot }
    | { mode: "pending"; pointerId: number; id: string; startX: number; startY: number; originX: number; originY: number }
    | null
  >(null);
  /** Where the current drag is heading, flushed once per animation frame. */
  const moveTarget = useRef<MoveTarget | null>(null);
  const moveFrame = useRef<number | null>(null);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  // Read the saved model after mount so server and client render the same
  // first frame, then keep the choice across reloads.
  useEffect(() => {
    const saved = window.localStorage.getItem(BRAIN_KEY);
    if (saved === "off") setBrain(null);
    else if (saved && isFlavorId(saved)) setBrain(saved);
    setBrainRestored(true);
  }, []);

  useEffect(() => {
    if (!brainRestored) return;
    window.localStorage.setItem(BRAIN_KEY, brain ?? "off");
  }, [brain, brainRestored]);

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  // A clip's request only answers at the end, so its tile asks the server how
  // far the render has got. A 404 just means no stage yet (or already done):
  // the tile keeps its last word rather than flickering back.
  const clipSlots = pending.filter((slot) => slot.kind === "video").map((slot) => slot.id).join(",");
  useEffect(() => {
    if (!clipSlots) {
      setTracks({});
      return;
    }
    const ids = clipSlots.split(",");
    let stopped = false;
    const poll = async () => {
      const results = await Promise.all(
        ids.map(async (id) => {
          try {
            const response = await fetch(`/api/video/progress?id=${encodeURIComponent(id)}`, { cache: "no-store" });
            return response.ok ? ([id, (await response.json()) as RenderTrack] as const) : undefined;
          } catch {
            return undefined;
          }
        }),
      );
      if (stopped) return;
      setTracks((current) => {
        const next: Record<string, RenderTrack> = {};
        for (const id of ids) if (current[id]) next[id] = current[id];
        for (const entry of results) if (entry) next[entry[0]] = entry[1];
        return next;
      });
    };
    void poll();
    const timer = setInterval(() => void poll(), 2_500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [clipSlots]);

  // Renders started before this mount keep their slots: the registry outlives
  // the component, so leaving for the grid and coming back shows what is still
  // running — and the finished frame still lands when the request returns.
  // A reload loses the registry, but clips are also saved in the browser: any
  // saved clip the registry does not know is one whose page went away, so its
  // tile comes back and the finished clip is collected from the server.
  useEffect(() => {
    const live = inFlightRenders.get(projectId) ?? [];
    const orphans = readSavedClips().filter(
      (clip) => clip.projectId === projectId && !live.some((slot) => slot.id === clip.slot.id),
    );
    setPending([...live, ...orphans.map((clip) => clip.slot)]);
    for (const clip of orphans) void resumeClip(clip);
    // resumeClip reads only refs and setters, so the project id is the only trigger.
  }, [projectId]);

  /**
   * Apply a project update from code that may outlive the workspace.
   *
   * A render keeps running after the canvas unmounts, and a state update on an
   * unmounted component is silently dropped — so when the workspace is gone
   * the same change is written to the store directly, which is where the next
   * mount reads from.
   */
  async function applyProjectUpdate(mutate: (project: Project) => Project) {
    if (mountedRef.current) {
      setProject((current) => (current ? mutate(current) : current));
      return;
    }
    try {
      const current = await readProject(projectId);
      if (current) await writeProject(mutate(current));
    } catch {
      // The store is unreachable; the render result dies with the page.
    }
  }

  /* ------------------------------- load / save ------------------------------ */

  const fit = useCallback((frames: Frame[]) => {
    const element = canvasRef.current;
    if (!element) return;
    const width = element.clientWidth;
    const height = element.clientHeight;
    const narrow = width <= 900;

    // Fit into the part of the canvas that floating chrome does not cover:
    // the left rail on desktop, the top strip above the sheet on mobile.
    const box = narrow
      ? { x: 0, y: 0, w: width, h: Math.max(220, height * 0.46) }
      : { x: 372, y: 76, w: Math.max(240, width - 372 - 24), h: Math.max(240, height - 164) };
    const padding = narrow ? 28 : 48;

    if (frames.length === 0) {
      setView({ x: box.x + box.w / 2, y: box.y + box.h / 2, zoom: 1 });
      return;
    }

    const bounds = frameBounds(frames);
    const zoom = clamp(
      Math.min(1, Math.min((box.w - padding * 2) / bounds.width, (box.h - padding * 2) / bounds.height)),
      MIN_ZOOM,
      1,
    );
    setView({
      zoom,
      x: box.x + box.w / 2 - (bounds.x + bounds.width / 2) * zoom,
      y: box.y + box.h / 2 - (bounds.y + bounds.height / 2) * zoom,
    });
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const project = await readProject(projectId);
        if (!alive) return;
        if (!project) {
          setLoadError("This browser has no project with that address.");
          return;
        }
        setProject(project);
        // The library is part of the project, so it comes back with it.
        setUploads(project.assets.map((asset) => ({ ...asset, origin: "upload" as const })));
        setLiked(project.saved);
        skipSave.current = true;
        requestAnimationFrame(() => fit(project.frames));
      } catch {
        if (alive) setLoadError("Could not read the project from this browser.");
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectId, fit]);

  useEffect(() => {
    if (!project) return;
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }

    setSaveState("saving");
    const timer = window.setTimeout(async () => {
      try {
        await writeProject({
          // The whole document, so a field added to Project can never be
          // silently dropped from the save. The library rides along beside
          // the frames because it belongs to the project, not the canvas.
          ...project,
          assets: uploads.map(({ id, kind, name, src, createdAt, seconds }) => ({
            id,
            kind,
            name,
            src,
            createdAt,
            ...(seconds ? { seconds } : {}),
          })),
          saved: liked,
        });
        setSaveState("saved");
        setSavedAt(Date.now());
      } catch {
        setSaveState("error");
      }
    }, SAVE_DELAY);

    return () => window.clearTimeout(timer);
  }, [project, uploads, liked]);

  /**
   * Put a clip's own settings back, filling in only what the frame recorded.
   *
   * Shared by `reuseFrame` and the model effect: the effect resets a model's
   * defaults whenever the model changes, which is exactly what a reuse must not
   * allow, so both paths land here and produce the same panel.
   */
  function applyClipSettings(model: VideoModel, want: Omit<ClipRestore, "model">) {
    setVideoMode(
      want.mode && model.modes.includes(want.mode as VideoMode)
        ? (want.mode as VideoMode)
        : model.modes.includes(videoMode)
          ? videoMode
          : "free",
    );
    setVideoRatio(findVideoRatio(want.ratio, model.ratio, model.ratios).id);
    setVideoResolution(findVideoResolution(want.resolution, model.resolution, model.resolutions));
    setVideoDuration((current) => clampDuration(want.duration ?? current, model));
  }

  useEffect(() => {
    const model = findVideoModel(videoModel) ?? DEFAULT_VIDEO_MODEL;

    // A reuse has already put the clip's own size and timing back; resetting
    // them to the model's defaults here is exactly what would lose them.
    const restore = pendingRestore.current;
    pendingRestore.current = null;
    if (restore && restore.model === model.id) {
      applyClipSettings(model, restore);
      return;
    }

    setVideoDuration((current) => clampDuration(current, model));
    setVideoRatio(model.ratio);
    setVideoResolution(model.resolution);
    // A model change drops a mode it does not offer rather than leaving a
    // disabled button selected.
    setVideoMode((current) => (model.modes.includes(current) ? current : "free"));
    // A prompt-only tier cannot carry the references picked for another one.
    if (model.references === false) {
      setCharacters([]);
      setBackground(undefined);
      setFirstFrame(undefined);
      setLastFrame(undefined);
      setAudioRef(undefined);
      setClipRef(undefined);
      setContinuation(undefined);
      continuePrior.current = null;
    }
  }, [videoModel]);

  useEffect(() => {
    const model = findImageTool(imageModel) ?? DEFAULT_TOOL;

    // A saved panel has already put its own shape, size and batch back; the
    // model's defaults would overwrite them, so this run applies the stored
    // ones instead.
    const restore = restoreImage.current;
    if (restore && restore.model === model.id) {
      restoreImage.current = null;
      setImageRatio(findImageRatio(restore.ratio, model.aspectRatio, model.ratios));
      setImageResolution(findImageResolution(restore.resolution, model.resolution, model.resolutions));
      setImageBatch(clampImageBatch(restore.batch, model.maxBatch));
      return;
    }

    // A stored shape, size or batch that the selected tool does not offer
    // clamps into its set instead of being sent as-is.
    setImageRatio((current) => findImageRatio(current, model.aspectRatio, model.ratios));
    setImageResolution((current) => findImageResolution(current, model.resolution, model.resolutions));
    setImageBatch((current) => clampImageBatch(current, model.maxBatch));
  }, [imageModel]);

  useEffect(() => {
    const model = findImageTool(imageModel) ?? DEFAULT_TOOL;
    // Only the local edit graph takes reference stills; with Edit off the
    // text-to-image graph has nowhere to put them.
    if (model.provider === "local" && !canvasEnabled) setImageReferences([]);
  }, [imageModel, canvasEnabled]);

  // Reopen the panel this project was last left with. Reading in an effect
  // keeps the server and client first render identical, and the write effect
  // below waits for this to finish so the defaults never hit the store.
  useEffect(() => {
    const saved = readPanelSettings(window.localStorage, projectId);
    if (saved) {
      if (saved.tab) setTab(saved.tab);
      if (saved.prompt !== undefined) setPrompt(saved.prompt);
      if (saved.videoPrompt !== undefined) setVideoPrompt(saved.videoPrompt);
      if (saved.chatDraft !== undefined) setChatDraft(saved.chatDraft);

      // The first render always starts on the default entries, so a saved panel
      // on one of them has no model change to ride: apply its size directly.
      // Any other entry is set here, and the model effect above applies the
      // saved shape through `restoreImage` instead of resetting to defaults.
      const tool = findImageTool(saved.imageModel ?? "") ?? DEFAULT_TOOL;
      if (tool.id === DEFAULT_TOOL.id) {
        setImageRatio(findImageRatio(saved.imageRatio, tool.aspectRatio, tool.ratios));
        setImageResolution(findImageResolution(saved.imageResolution, tool.resolution, tool.resolutions));
        setImageBatch(clampImageBatch(saved.imageBatch, tool.maxBatch));
      } else {
        restoreImage.current = {
          model: tool.id,
          ratio: saved.imageRatio,
          resolution: saved.imageResolution,
          batch: saved.imageBatch,
        };
        setImageModel(tool.id);
      }

      const clip = findVideoModel(saved.videoModel ?? "") ?? DEFAULT_VIDEO_MODEL;
      if (clip.id === DEFAULT_VIDEO_MODEL.id) {
        setVideoRatio(findVideoRatio(saved.videoRatio, clip.ratio, clip.ratios).id);
        setVideoResolution(
          findVideoResolution(saved.videoResolution, clip.resolution, clip.resolutions),
        );
        setVideoDuration((current) => clampDuration(saved.videoDuration ?? current, clip));
      } else {
        // The clip effect consumes this instead of resetting to the model's
        // own defaults, exactly as a Reuse does.
        pendingRestore.current = {
          model: clip.id,
          ratio: saved.videoRatio,
          resolution: saved.videoResolution,
          duration: saved.videoDuration,
        };
        setVideoModel(clip.id);
      }
    }
    setPanelProject(projectId);
  }, [projectId]);

  // Save the panel for the next visit. Attachments stay out: a reference is
  // the uploaded file itself, and a reload asks for it again.
  useEffect(() => {
    if (panelProject !== projectId) return;
    writePanelSettings(window.localStorage, projectId, {
      tab,
      prompt,
      imageModel,
      imageRatio,
      imageResolution,
      imageBatch,
      videoPrompt,
      videoModel,
      videoRatio,
      videoResolution,
      videoDuration,
      chatDraft,
    });
  }, [
    panelProject,
    projectId,
    tab,
    prompt,
    imageModel,
    imageRatio,
    imageResolution,
    imageBatch,
    videoPrompt,
    videoModel,
    videoRatio,
    videoResolution,
    videoDuration,
    chatDraft,
  ]);

  useEffect(() => {
    // The local model names live in this browser, like the account.
    const load = () => setLocalConfig(readSettings().localModel ?? null);
    load();
    return onSettingsChange(load);
  }, []);

  function openLocalConfig() {
    setLocalError(undefined);
    setVerifyResult(null);
    // Nothing saved yet means the defaults are what the next render would use,
    // so the dialog starts from those rather than from empty boxes.
    const current = localConfig ?? LOCAL_MODEL_DEFAULTS;
    setLocalDraft({
      unet: current.unet,
      clip: current.clip,
      steps: String(current.steps),
      refVideoEdge: String(current.refVideoEdge),
    });
    setVideoModelOpen(false);
    setLocalConfigOpen(true);
  }

  async function verifyLocalConfig(overrides?: { unet?: string; clip?: string }) {
    setVerifying(true);
    setVerifyResult(null);
    try {
      const response = await apiFetch("/api/local-model/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          unet: (overrides?.unet ?? localDraft.unet).trim(),
          clip: (overrides?.clip ?? localDraft.clip).trim(),
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        checked?: boolean;
        host?: string;
        unet?: { name: string; found?: boolean };
        clip?: { name: string; found?: boolean };
        note?: string;
        error?: string;
      };
      if (!response.ok) {
        setVerifyResult({ error: data.error ?? `Verification failed (${response.status}).` });
        return;
      }
      setVerifyResult(data);
    } catch {
      setVerifyResult({ error: "Could not reach the app server." });
    } finally {
      setVerifying(false);
    }
  }

  function saveLocalConfig(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalBusy(true);
    setLocalError(undefined);

    const unet = localDraft.unet.trim();
    const clip = localDraft.clip.trim();
    const steps = Number(localDraft.steps);
    if (!unet || !clip) {
      setLocalError("Both model names are required.");
      setLocalBusy(false);
      return;
    }
    if (!Number.isFinite(steps) || steps < 1 || steps > 200) {
      setLocalError("Steps must be a whole number from 1 to 200.");
      setLocalBusy(false);
      return;
    }

    const config = localModelConfig({
      unet,
      clip,
      steps: Math.round(steps),
      refVideoEdge: Number(localDraft.refVideoEdge),
    });
    rememberLocalModel(config);
    setLocalConfig(config);
    setLocalConfigOpen(false);
    setLocalBusy(false);
  }

  useEffect(() => {
    if (tab !== "chat") return;
    const log = chatLogRef.current;
    if (!log) return;
    // One frame later, so the log has its final height when it is pinned to
    // the newest message rather than the height it had while mounting.
    const frame = requestAnimationFrame(() => {
      log.scrollTop = log.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [tab, project?.messages.length]);

  /* --------------------------------- history -------------------------------- */

  const mutate = useCallback((apply: (current: Project) => Partial<Project>) => {
    const current = projectRef.current;
    if (!current) return;
    setPast((history) => [...history.slice(-49), { frames: current.frames, messages: current.messages }]);
    setFuture([]);
    const next = { ...current, ...apply(current), updatedAt: Date.now() };
    projectRef.current = next;
    setProject(next);
  }, []);

  const undo = useCallback(() => {
    const current = projectRef.current;
    const snapshot = past[past.length - 1];
    if (!current || !snapshot) return;

    setPast((history) => history.slice(0, -1));
    setFuture((queue) => [{ frames: current.frames, messages: current.messages }, ...queue].slice(0, 50));
    const next = { ...current, ...snapshot, updatedAt: Date.now() };
    projectRef.current = next;
    setProject(next);
  }, [past]);

  const redo = useCallback(() => {
    const current = projectRef.current;
    const snapshot = future[0];
    if (!current || !snapshot) return;

    setFuture((queue) => queue.slice(1));
    setPast((history) => [...history.slice(-49), { frames: current.frames, messages: current.messages }]);
    const next = { ...current, ...snapshot, updatedAt: Date.now() };
    projectRef.current = next;
    setProject(next);
  }, [future]);

  /* ---------------------------------- canvas -------------------------------- */

  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;

    function onWheel(event: WheelEvent) {
      event.preventDefault();
      const rect = element!.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      const current = viewRef.current;
      const zoom = clamp(current.zoom * Math.exp(-event.deltaY * 0.0015), MIN_ZOOM, MAX_ZOOM);
      const scale = zoom / current.zoom;
      setView({
        zoom,
        x: pointerX - (pointerX - current.x) * scale,
        y: pointerY - (pointerY - current.y) * scale,
      });
    }

    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  /** Apply a drag position to whichever thing is moving. */
  function applyMove(target: MoveTarget) {
    if (target.mode === "pan") {
      setView((current) =>
        current.x === target.x && current.y === target.y ? current : { ...current, x: target.x, y: target.y },
      );
      return;
    }

    if (target.mode === "frame") {
      setProject((current) => {
        if (!current) return current;
        let changed = false;
        const frames = current.frames.map((frame) => {
          if (frame.id !== target.id || (frame.x === target.x && frame.y === target.y)) return frame;
          changed = true;
          return { ...frame, x: target.x, y: target.y };
        });
        return changed ? { ...current, frames } : current;
      });
      return;
    }

    // The registry is the surviving copy, so a dragged slot moves in both.
    let changed = false;
    const next = pendingRef.current.map((slot) => {
      if (slot.id !== target.id || (slot.x === target.x && slot.y === target.y)) return slot;
      changed = true;
      return { ...slot, x: target.x, y: target.y };
    });
    if (changed) {
      setPending(next);
      inFlightRenders.set(projectId, next);
    }
  }

  /** Remember where the pointer is and apply it on the next frame, once. */
  function scheduleMove(target: MoveTarget) {
    moveTarget.current = target;
    if (moveFrame.current !== null) return;

    moveFrame.current = requestAnimationFrame(() => {
      moveFrame.current = null;
      const latest = moveTarget.current;
      moveTarget.current = null;
      if (latest) applyMove(latest);
    });
  }

  function startPan(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const onEmpty = event.target === event.currentTarget;
    if (tool !== "hand" && !spaceHeld.current && !onEmpty) return;
    // A press on empty canvas drops the selection, so one click clears it.
    if (onEmpty && tool === "select" && !spaceHeld.current) setSelected(null);
    capturePointer(event.currentTarget, event.pointerId);
    drag.current = {
      mode: "pan",
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: view.x,
      originY: view.y,
    };
  }

  function startFrameDrag(event: React.PointerEvent<HTMLDivElement>, frame: Frame) {
    if (event.button !== 0) return;
    event.stopPropagation();
    setSelected(frame.id);

    const now = Date.now();
    const previous = lastPress.current;
    lastPress.current = { id: frame.id, at: now };
    if (previous.id === frame.id && now - previous.at < 400) {
      // Double-click: open the frame full size instead of starting a drag.
      lastPress.current = { id: "", at: 0 };
      setViewer(frame.id);
      return;
    }

    if (tool !== "select" || !project) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    capturePointer(canvas, event.pointerId);
    drag.current = {
      mode: "frame",
      pointerId: event.pointerId,
      id: frame.id,
      startX: event.clientX,
      startY: event.clientY,
      originX: frame.x,
      originY: frame.y,
      snapshot: { frames: project.frames, messages: project.messages },
    };
  }

  /**
   * Drag a render in flight.
   *
   * The blueprint used to ignore the pointer, so a clip that took minutes held
   * its slot exactly where the grid put it. It moves like a frame now — and the
   * finished render lands where it was dropped, because the frame is created
   * from the slot's position at the moment the response arrives.
   */
  function startPendingDrag(event: React.PointerEvent<HTMLDivElement>, slot: PendingRender) {
    if (event.button !== 0) return;
    // With the hand tool the press belongs to the canvas, which pans. Nothing
    // is selected here, so there is no reason to swallow it first.
    if (tool !== "select" || !project) return;
    event.stopPropagation();

    const canvas = canvasRef.current;
    if (!canvas) return;
    capturePointer(canvas, event.pointerId);
    drag.current = {
      mode: "pending",
      pointerId: event.pointerId,
      id: slot.id,
      startX: event.clientX,
      startY: event.clientY,
      originX: slot.x,
      originY: slot.y,
    };
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state) return;

    const zoom = viewRef.current.zoom;

    if (state.mode === "pending") {
      scheduleMove({
        mode: "pending",
        id: state.id,
        x: Math.round(state.originX + (event.clientX - state.startX) / zoom),
        y: Math.round(state.originY + (event.clientY - state.startY) / zoom),
      });
      return;
    }

    if (state.mode === "pan") {
      scheduleMove({
        mode: "pan",
        x: state.originX + (event.clientX - state.startX),
        y: state.originY + (event.clientY - state.startY),
      });
      return;
    }

    scheduleMove({
      mode: "frame",
      id: state.id,
      x: Math.round(state.originX + (event.clientX - state.startX) / zoom),
      y: Math.round(state.originY + (event.clientY - state.startY) / zoom),
    });
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    const state = drag.current;
    drag.current = null;

    // A release can land between frames: apply the last pointer position so the
    // drag stops exactly where the pointer did, rather than a frame behind it.
    if (moveFrame.current !== null) {
      cancelAnimationFrame(moveFrame.current);
      moveFrame.current = null;
    }
    const last = moveTarget.current;
    moveTarget.current = null;
    if (last) applyMove(last);

    if (!state) return;
    if (event.currentTarget.hasPointerCapture(state.pointerId)) {
      event.currentTarget.releasePointerCapture(state.pointerId);
    }
    if (state.mode === "frame") {
      setPast((history) => [...history.slice(-49), state.snapshot]);
      setFuture([]);
    }
  }

  function zoomBy(factor: number) {
    const element = canvasRef.current;
    if (!element) return;
    const current = viewRef.current;
    const zoom = clamp(current.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const scale = zoom / current.zoom;
    const centerX = element.clientWidth / 2;
    const centerY = element.clientHeight / 2;
    setView({
      zoom,
      x: centerX - (centerX - current.x) * scale,
      y: centerY - (centerY - current.y) * scale,
    });
  }

  /* --------------------------------- actions -------------------------------- */

  const deleteFrame = useCallback(
    (id: string) => {
      mutate((current) => ({ frames: current.frames.filter((frame) => frame.id !== id) }));
      setSelected((current) => (current === id ? null : current));
    },
    [mutate],
  );

  /**
   * Delete in two steps: the first press arms the button, a second one within a
   * few seconds removes the frame. The same armed state drives the selection bar
   * and the viewer, so a stray click can never throw a render away.
   */
  const requestDelete = useCallback(
    (id: string) => {
      window.clearTimeout(deleteTimer.current);
      if (pendingDelete === id) {
        setPendingDelete(null);
        deleteFrame(id);
        setViewer((current) => (current === id ? null : current));
        return;
      }
      setPendingDelete(id);
      deleteTimer.current = window.setTimeout(() => setPendingDelete(null), 3000);
    },
    [pendingDelete, deleteFrame],
  );

  // A new selection or a closed viewer is a new context: never leave a delete armed.
  useEffect(() => {
    setPendingDelete(null);
    window.clearTimeout(deleteTimer.current);
  }, [selected, viewer]);

  useEffect(() => () => window.clearTimeout(deleteTimer.current), []);

  useEffect(() => {
    function isTyping(target: EventTarget | null) {
      const element = target as HTMLElement | null;
      if (!element) return false;
      return (
        element.tagName === "INPUT" ||
        element.tagName === "TEXTAREA" ||
        element.tagName === "SELECT" ||
        element.isContentEditable
      );
    }

    function onKeyDown(event: KeyboardEvent) {
      if (isTyping(event.target)) return;

      if (event.key === " ") {
        spaceHeld.current = true;
        setTool("hand");
        event.preventDefault();
        return;
      }
      if (event.key === "Escape") {
        // Overlays sit on top of the canvas, so they take the first Escape.
        if (mediaView) {
          setMediaView(null);
          return;
        }
        if (viewer) {
          setViewer(null);
          return;
        }
        setSelected(null);
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && selected) {
        event.preventDefault();
        deleteFrame(selected);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      }
    }

    function onKeyUp(event: KeyboardEvent) {
      if (event.key === " ") {
        spaceHeld.current = false;
        setTool("select");
      }
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [selected, viewer, mediaView, deleteFrame, undo, redo]);

  async function send(text: string) {
    const value = text.replace(/\s+/g, " ").trim();
    if (!value || !project || busy) return;
    if (canvasEnabled && !canvasImage) {
      setFailed(true);
      setStatus("Choose an image to edit.");
      return;
    }

    setBusy(true);
    setFailed(false);
    setNotice(undefined);
    setStatus("Thinking…");

    const userMessage: Message = { id: crypto.randomUUID(), role: "user", text: value, createdAt: Date.now() };
    const base: Project = { ...project, messages: [...project.messages, userMessage] };
    setProject(base);

    // Claim one slot per image before the request goes out: each blueprint
    // square fills while it works, and a take lands in that exact spot.
    const batch = clampImageBatch(imageBatch, activeImageModel.maxBatch);
    const claimed: { x: number; y: number }[] = [...base.frames, ...pending];
    const slots: { id: string; x: number; y: number }[] = [];
    for (let index = 0; index < batch; index += 1) {
      const spot = nextPosition(claimed);
      slots.push({ id: crypto.randomUUID(), ...spot });
      claimed.push(spot);
    }
    setPending((list) => [
      ...list,
      ...slots.map((slot) => ({ id: slot.id, x: slot.x, y: slot.y, kind: "image" as const, prompt: value })),
    ]);
    claimInFlight(
      project.id,
      slots.map((slot) => ({ id: slot.id, x: slot.x, y: slot.y, kind: "image" as const, prompt: value })),
    );

    try {
      const response = await apiFetch("/api/harness", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: value,
          imageModel,
          render: true,
          ratio: canvasEnabled ? "auto" : imageRatio,
          resolution: imageResolution,
          batch,
          enhance: !canvasEnabled && brain !== null,
          ...(brain && !canvasEnabled ? { brain } : {}),
          ...(canvasEnabled && canvasImage ? { canvas: canvasImage.base64 } : {}),
          ...(takesImageReferences && imageReferences.length > 0
            ? { references: imageReferences.map((item) => item.base64) }
            : {}),
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        kind?: "answer" | "image";
        answer?: string;
        src?: string;
        srcs?: string[];
        prompt?: string;
        sourcePrompt?: string;
        enhanced?: boolean;
        route?: { tool?: { model?: string; aspectRatio?: string; resolution?: string } };
        error?: string;
      };

      if (!response.ok || !data.kind) throw new Error(data.error ?? "The harness could not answer that.");

      if (data.kind === "answer") {
        const reply: Message = {
          id: crypto.randomUUID(),
          role: "assistant",
          text: data.answer ?? "",
          createdAt: Date.now(),
        };
        await applyProjectUpdate((current) =>
          current ? { ...current, messages: [...current.messages, reply], updatedAt: Date.now() } : current,
        );
        if (mountedRef.current) {
          setTab("chat");
          setPrompt("");
          setStatus(undefined);
        }
        return;
      }

      const sources = data.srcs?.length ? data.srcs : data.src ? [data.src] : [];
      if (sources.length === 0) throw new Error("The render did not return an image.");

      // The route answers with the bytes; this browser keeps them, so a frame
      // outlives the tab without anything being stored on the server.
      const stored = await Promise.all(sources.map((src) => putDataUrl(src, "render.png")));
      const canvasSrc = canvasEnabled && canvasImage ? await putJpeg(canvasImage.base64) : undefined;
      const referenceSrcs =
        takesImageReferences && imageReferences.length > 0
          ? await Promise.all(imageReferences.map((item) => putJpeg(item.base64)))
          : [];

      // A blueprint may have been dragged while the render ran.
      const newFrames: Frame[] = stored.map((src, index) => {
        const slot = slots[index];
        const placed = slot ? pendingRef.current.find((item) => item.id === slot.id) : undefined;
        return {
          id: slot?.id ?? crypto.randomUUID(),
          src,
          prompt: data.prompt ?? value,
          sourcePrompt: data.sourcePrompt ?? value,
          enhanced: data.enhanced === true,
          // The whole call, so Reuse can make it again and the viewer can say
          // which size and enhancer produced this frame.
          recipe: {
            tab: "create",
            flavor: canvasEnabled ? null : brain,
            image: imageModel,
            ratio: data.route?.tool?.aspectRatio ?? (canvasEnabled ? "auto" : imageRatio),
            resolution: data.route?.tool?.resolution ?? imageResolution,
            batch,
            ...(canvasEnabled ? { canvas: true } : {}),
          },
          characterSrcs: [],
          referenceSrcs,
          canvasSrc,
          media: "image",
          style: "none",
          model: data.route?.tool?.model ?? imageModel,
          x: placed?.x ?? slot?.x ?? 0,
          y: placed?.y ?? slot?.y ?? 0,
          createdAt: Date.now(),
        };
      });

      const first = newFrames[0]!;
      const summary =
        `${canvasEnabled ? "Edited" : data.enhanced ? "Enhanced prompt" : "Rendered"}: ${first.prompt}` +
        (newFrames.length > 1 ? ` (${newFrames.length} images)` : "");

      await applyProjectUpdate((current) => {
        const frames = [...current.frames, ...newFrames].slice(0, MAX_FRAMES);
        return {
          ...current,
          frames,
          messages: [
            ...current.messages,
            {
              id: crypto.randomUUID(),
              role: "assistant" as const,
              text: summary,
              createdAt: Date.now(),
            },
          ],
          updatedAt: Date.now(),
        };
      });

      if (mountedRef.current) {
        setPrompt("");
        setStatus(undefined);
        setSelected(newFrames[newFrames.length - 1]!.id);
        if (base.frames.length === 0) requestAnimationFrame(() => fit(newFrames));
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The request failed.";
      setFailed(true);
      setStatus(message);
      // A checkpoint the target does not have is fixed in the gear, so open it
      // with the target's real list already fetched.
      if (activeImageModel.provider === "local" && isMissingModelError(message)) {
        setImageConfigAutoVerify(true);
        setImageConfigOpen(true);
      }
    } finally {
      const claimedIds = new Set(slots.map((slot) => slot.id));
      releaseInFlight(projectId, [...claimedIds]);
      setPending((list) => list.filter((slot) => !claimedIds.has(slot.id)));
      setBusy(false);
    }
  }

  /**
   * Put a chat plan on the panel.
   *
   * State only, which is the whole of the chat's control: no render starts
   * here, and the route refuses to render a chat turn, so a preset can only
   * leave the panel ready for a button the person presses themselves.
   */
  function applyStudioPlan(plan: StudioPlan) {
    setFailed(false);
    setStatus(undefined);
    setNotice(undefined);

    if (plan.tab === "create") {
      const tool = (plan.image ? findImageTool(plan.image) : undefined) ?? activeImageModel;
      if (plan.image && tool.id !== imageModel) setImageModel(tool.id);
      if (typeof plan.edit === "boolean") setCanvasEnabled(plan.edit);
      if (plan.prompt) setPrompt(plan.prompt);
      if (plan.ratio) setImageRatio(findImageRatio(plan.ratio, tool.aspectRatio, tool.ratios));
      if (plan.resolution) {
        setImageResolution(findImageResolution(plan.resolution, tool.resolution, tool.resolutions));
      }
      if (plan.batch) setImageBatch(clampImageBatch(plan.batch, tool.maxBatch));
    } else if (plan.tab === "video") {
      const model = (plan.video ? findVideoModel(plan.video) : undefined) ?? activeVideoModel;
      // The model effect resets a clip's shape, size and length to its own
      // defaults, so a plan takes the same restore path Reuse uses.
      const want: Omit<ClipRestore, "model"> = {
        mode: plan.mode ?? videoMode,
        ratio: plan.ratio ?? videoRatio,
        resolution: plan.resolution ?? videoResolution,
        duration: plan.seconds ?? videoDuration,
      };
      if (model.id !== videoModel) {
        pendingRestore.current = { model: model.id, ...want };
        setVideoModel(model.id);
      }
      if (plan.prompt) setVideoPrompt(plan.prompt);
      applyClipSettings(model, want);
    }

    setTab(plan.tab);
    setNotice("Preset applied. Nothing was generated.");
  }

  /**
   * One chat turn.
   *
   * The brain either answers or hands back a plan. Both land in the chat log;
   * a plan also moves the panel. Nothing is sent to an image or video model,
   * because `/api/harness` answers a chat turn before it builds a render.
   */
  async function sendChat(text: string) {
    const value = text.replace(/\s+/g, " ").trim();
    if (!value || !project || busy) return;

    setBusy(true);
    setFailed(false);
    setNotice(undefined);
    setStatus("Thinking…");

    const userMessage: Message = { id: crypto.randomUUID(), role: "user", text: value, createdAt: Date.now() };
    setProject((current) =>
      current ? { ...current, messages: [...current.messages, userMessage] } : current,
    );

    try {
      const response = await apiFetch("/api/harness", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "chat",
          prompt: value,
          ...(brain ? { brain } : {}),
          // Both generators, so the brain can read the panel the chat is not
          // covering: the chat normally runs from its own tab. This is context
          // for the model only, never applied by the route.
          state: {
            tab,
            create: {
              prompt,
              image: imageModel,
              edit: canvasEnabled,
              ratio: imageRatio,
              resolution: imageResolution,
              batch: imageBatch,
            },
            video: {
              prompt: videoPrompt,
              video: videoModel,
              mode: videoMode,
              ratio: videoRatio,
              resolution: videoResolution,
              seconds: videoDuration,
            },
            frames: project.frames.length,
          },
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        kind?: "answer" | "plan";
        answer?: string;
        reply?: string;
        plan?: StudioPlan;
        error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? "The harness could not answer that.");

      let reply: string;
      if (data.kind === "plan" && data.plan) {
        applyStudioPlan(data.plan);
        reply = data.reply ?? "Preset applied. Nothing was generated.";
      } else if (data.answer) {
        reply = data.answer;
      } else {
        throw new Error("The harness returned nothing.");
      }

      setProject((current) =>
        current
          ? {
              ...current,
              messages: [
                ...current.messages,
                { id: crypto.randomUUID(), role: "assistant", text: reply, createdAt: Date.now() },
              ],
              updatedAt: Date.now(),
            }
          : current,
      );
      setStatus(undefined);
    } catch (cause) {
      setFailed(true);
      setStatus(cause instanceof Error ? cause.message : "The harness could not answer that.");
    } finally {
      setBusy(false);
    }
  }

  async function sendVideo() {
    const value = videoPrompt.replace(/\s+/g, " ").trim();
    // A reference mode works on the attachments alone — "replace this subject
    // with this character" is already the whole brief.
    if ((!value && videoMode === "free") || !project || busy) return;

    if (videoMode === "audio" && !audioRef) {
      setFailed(true);
      setStatus("Audio Reference needs an audio file.");
      return;
    }
    if (videoMode === "video" && !clipRef) {
      setFailed(true);
      setStatus("Video Reference needs a clip.");
      return;
    }

    setBusy(true);
    setFailed(false);
    setNotice(undefined);
    setStatus("Rendering the clip… a video pass takes minutes.");

    // Router takes a clip, never a time range, so the tail is cut here — the
    // same re-encode the pre-upload editor uses. The local graph needs no file:
    // it slices the frames on the server, exactly and without re-encoding.
    let continuationVideo: string | undefined;
    if (continuation && clipRef && activeVideoModel.provider !== "local") {
      setStatus("Cutting the last frames of the reference…");
      try {
        const tail = await recordTail(clipRef.dataUrl, CONTINUATION_FRAMES);
        continuationVideo = await dataUrlFromBlob(tail);
        setStatus("Rendering the clip… a video pass takes minutes.");
      } catch {
        // No tail to send: the rewritten prompt still carries the continuity.
      }
    }

    const caption = value || `${videoModeLabel(videoMode)} reference`;
    const userMessage: Message | null = value
      ? { id: crypto.randomUUID(), role: "user", text: value, createdAt: Date.now() }
      : null;
    const base: Project = {
      ...project,
      messages: userMessage ? [...project.messages, userMessage] : project.messages,
    };
    setProject(base);

    // A clip takes minutes: its square is on the canvas, filling, the whole time.
    const position = nextPosition([...base.frames, ...pending]);
    const renderId = crypto.randomUUID();
    const slot: PendingRender = { id: renderId, x: position.x, y: position.y, kind: "video", prompt: value };
    setPending((list) => [...list, slot]);
    claimInFlight(project.id, [slot]);

    try {
      // The stills are stored before the render rather than after, so a page
      // that reloads mid-render still has them for the frame it collects.
      // The keyframe modes ignore the character and background slots, so the
      // frame only records what was actually sent.
      const keyed = Boolean(firstFrame || lastFrame);
      const meta: ClipMeta = {
        value,
        caption,
        mode: videoMode,
        model: videoModel,
        ratio: videoRatio,
        resolution: videoResolution,
        duration: videoDuration,
        brain,
        characterSrcs: keyed ? [] : await Promise.all(characters.map((item) => putJpeg(item.base64))),
        backgroundSrc: keyed || !background ? undefined : await putJpeg(background.base64),
      };
      saveClip({ projectId: project.id, slot, meta, startedAt: Date.now() });

      const response = await apiFetch("/api/video", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: value,
          mode: videoMode,
          model: videoModel,
          ratio: videoRatio,
          resolution: videoResolution,
          duration: videoDuration,
          characters: characters.map((item) => item.base64),
          ...(background ? { background: background.base64 } : {}),
          ...(firstFrame ? { firstFrame: firstFrame.base64 } : {}),
          ...(lastFrame ? { lastFrame: lastFrame.base64 } : {}),
          ...(audioRef ? { audio: audioRef.dataUrl } : {}),
          ...(clipRef ? { video: clipRef.dataUrl } : {}),
          ...(continuationVideo ? { continuationVideo } : {}),
          ...(continuation ? { continuation: true } : {}),
          renderId,
          // A reference clip is always rewritten, and the server owns that
          // model, so this mode sends no brain of its own.
          enhance: videoMode !== "free" || brain !== null,
          ...(videoMode === "free" && brain ? { brain } : {}),
        }),
      });

      // A route that failed before it could answer — a compile error, a
      // gateway timeout — sends an HTML page, which parses to nothing. Say
      // which status came back instead of swallowing it as "could not render".
      const data = (await response.json().catch(() => ({}))) as {
        kind?: "video";
        src?: string;
        prompt?: string;
        sourcePrompt?: string;
        enhanced?: boolean;
        model?: string;
        error?: string;
      };

      if (!response.ok || !data.kind || !data.src) {
        throw new Error(data.error ?? `The clip could not be rendered (HTTP ${response.status}).`);
      }

      // The blueprint may have been dragged while the clip rendered.
      const placed = pendingRef.current.find((slot) => slot.id === renderId);
      const frame = await clipFrame(renderId, { ...data, src: data.src }, meta, placed ?? position);

      await applyProjectUpdate((current) => ({
        ...current,
        frames: [...current.frames, frame].slice(0, MAX_FRAMES),
        messages: [...current.messages, clipMessage(meta, frame)],
        updatedAt: Date.now(),
      }));

      if (mountedRef.current) {
        setVideoPrompt("");
        setStatus(undefined);
        setSelected(frame.id);
        if (base.frames.length === 0) requestAnimationFrame(() => fit([frame]));
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The clip could not be rendered.";
      setFailed(true);
      setStatus(message);
      // A name the target does not have is fixed in the gear, so show it there
      // with the target's real checkpoint list already fetched.
      if (activeVideoModel.provider === "local" && isMissingModelError(message)) {
        openLocalConfig();
        void verifyLocalConfig({ unet: localConfig?.unet, clip: localConfig?.clip });
      }
    } finally {
      // The answer came straight back, success or not, so the server's kept
      // copy (for a page that reloaded) can go.
      void fetch(`/api/video/result?id=${encodeURIComponent(renderId)}`, { method: "DELETE" }).catch(() => {});
      releaseInFlight(projectId, [renderId]);
      setPending((list) => list.filter((slot) => slot.id !== renderId));
      setBusy(false);
    }
  }

  /**
   * Collect a clip whose page reloaded while it rendered.
   *
   * The server finished (or is still running) the render and keeps its answer
   * under the tile id, so this waits on the tile's progress record and then
   * takes the answer. Three misses in a row mean the server holds nothing —
   * it restarted, or the clip is older than it keeps — and the tile goes with
   * a message rather than spinning forever. Leaving the canvas stops the
   * wait without forgetting the clip; the next visit picks it up again.
   */
  async function resumeClip(clip: SavedClip) {
    const id = clip.slot.id;
    if (resumingClips.has(id)) return;
    resumingClips.add(id);
    let settled = false;
    let misses = 0;
    try {
      while (mountedRef.current) {
        let stage: string | undefined;
        let error: string | undefined;
        try {
          const response = await fetch(`/api/video/progress?id=${encodeURIComponent(id)}`, { cache: "no-store" });
          if (response.ok) {
            ({ stage, error } = (await response.json()) as { stage?: string; error?: string });
            misses = 0;
          } else if (response.status === 404) {
            misses += 1;
          }
        } catch {
          // The app server is down for a moment; keep waiting.
        }

        if (stage === "done") {
          const response = await fetch(`/api/video/result?id=${encodeURIComponent(id)}`, { cache: "no-store" });
          const data = (await response.json().catch(() => ({}))) as Parameters<typeof clipFrame>[1] & { error?: string };
          settled = true;
          if (!response.ok || !data.src) {
            setFailed(true);
            setStatus(data.error ?? "The clip finished, but it could not be collected after the reload.");
            break;
          }
          const placed = pendingRef.current.find((slot) => slot.id === id) ?? clip.slot;
          const frame = await clipFrame(id, data, clip.meta, placed);
          await applyProjectUpdate((current) => ({
            ...current,
            frames: [...current.frames, frame].slice(0, MAX_FRAMES),
            messages: [...current.messages, clipMessage(clip.meta, frame)],
            updatedAt: Date.now(),
          }));
          break;
        }
        if (stage === "failed") {
          settled = true;
          setFailed(true);
          setStatus(error ?? "The clip could not be rendered.");
          break;
        }
        if (misses >= 3) {
          settled = true;
          setFailed(true);
          setStatus("A clip that was rendering before the page reloaded could not be recovered.");
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    } finally {
      resumingClips.delete(id);
      if (settled) {
        forgetClips([id]);
        if (mountedRef.current) setPending((list) => list.filter((slot) => slot.id !== id));
      }
    }
  }

  /**
   * Put the panel back the way it was when this frame was made.
   *
   * The typed prompt comes back, not the rewrite: the rewrite is in the frame's
   * metadata, and re-sending it would pay for an enhancement of an enhancement.
   * Everything else — tab, style, clip model and timing, the enhancer, and the
   * reference stills — is restored from the recipe. A reference clip cannot be
   * restored: only its rewrite is stored, so that mode comes back empty and
   * says so rather than pretending it is ready.
   */
  async function reuseFrame(frame: Frame, overrides?: { mode?: VideoMode }) {
    const recipe = frame.recipe;
    // An empty prompt is a real answer (a reference render needs no words), and
    // only a frame made before prompts were recorded falls back to its caption.
    const typed = frame.sourcePrompt !== undefined ? frame.sourcePrompt.trim() : frame.prompt;
    // Frames made before recipes existed still know what they are: a clip. The
    // tab follows the media, not the presence of a recipe, or every old clip
    // would open on the Create tab.
    const isClip = recipe ? recipe.tab === "video" : isVideoSrc(frame.src);
    setViewer(null);
    setSelected(frame.id);
    setFailed(false);
    setNotice(undefined);
    // A plain reuse is not a continuation; the tab only exists while one is
    // armed, and `continueFrame` re-arms it afterwards.
    setContinuation(undefined);
    continuePrior.current = null;

    if (isClip) {
      setTab("video");
      setVideoPrompt(typed);
      const clip = recipe?.video;
      // A legacy clip recorded its model and length on the frame itself.
      const modelId = clip?.model ?? frame.model;
      const model = modelId ? findVideoModel(modelId) : undefined;
      if (model) {
        const want: ClipRestore = {
          model: model.id,
          mode: overrides?.mode ?? clip?.mode,
          ratio: clip?.ratio,
          resolution: clip?.resolution,
          duration: clip?.duration ?? frame.seconds,
        };
        // The model effect would reset these to its defaults; this says which
        // model they belong to. Applying them here as well covers the case
        // where the model is already the one the clip used, so no effect runs.
        pendingRestore.current = want;
        setVideoModel(model.id);
        applyClipSettings(model, want);
      }
      if (clip && clip.mode !== "free") {
        setNotice("Re-attach the reference clip, then generate again.");
      }
      // Omitted means the mode never used an enhancer, so the button keeps
      // whatever the person had chosen.
      if (recipe?.flavor) setBrain(recipe.flavor);
      else if (recipe?.flavor === null) setBrain(null);
    } else {
      setTab("create");
      if (recipe?.image && findImageTool(recipe.image)) setImageModel(recipe.image);
      setPrompt(typed);
      setCanvasEnabled(recipe?.canvas === true);
      if (recipe?.ratio && !recipe?.canvas) setImageRatio(findImageRatio(recipe.ratio));
      if (recipe?.resolution) setImageResolution(findImageResolution(recipe.resolution));
      if (recipe?.batch) setImageBatch(clampImageBatch(recipe.batch));
      if (recipe?.flavor) setBrain(recipe.flavor);
      else if (recipe?.flavor === null) setBrain(null);
    }

    // The reference stills were saved as renders, so they come back as the same
    // images rather than as paths the next call could not send.
    const [restoredCharacterList, restoredBackground] = await Promise.all([
      Promise.all((frame.characterSrcs ?? []).map(referenceFromSrc)),
      frame.backgroundSrc ? referenceFromSrc(frame.backgroundSrc) : Promise.resolve(undefined),
    ]);
    const restoredCharacters = restoredCharacterList.filter((item): item is Reference => Boolean(item));
    const referenceSources = frame.referenceSrcs?.length
      ? frame.referenceSrcs
      : frame.referenceSrc
        ? [frame.referenceSrc]
        : [];
    if (!isClip) {
      // New stills carry the generic list; older ones split it into a character
      // and a background, so the first of those fills the first slot.
      const restoredReferences =
        referenceSources.length > 0
          ? (await Promise.all(referenceSources.map(referenceFromSrc))).filter(
              (item): item is Reference => Boolean(item),
            )
          : [restoredCharacters[0] ?? restoredBackground].filter((item): item is Reference => Boolean(item));
      setImageReferences(restoredReferences.slice(0, MAX_IMAGE_REFERENCES));
      setCanvasImage(frame.canvasSrc ? await referenceFromSrc(frame.canvasSrc) : undefined);
    }
    setCharacters(restoredCharacters);
    setBackground(restoredBackground);
    setFirstFrame(undefined);
    setLastFrame(undefined);
  }

  /**
   * Leave Continue and put Video Reference back the way it was.
   *
   * Continue's clip, prompt and stills came out of the clip it extends; none of
   * them belong to the mode being chosen.
   */
  function leaveContinuation() {
    if (!continuation) return;
    const prior = continuePrior.current;
    continuePrior.current = null;
    setContinuation(undefined);
    setClipRef(prior?.clip);
    setVideoPrompt(prior?.prompt ?? "");
    setCharacters(prior?.characters ?? []);
    setBackground(prior?.background);
  }

  /**
   * Arm a continuation of this clip.
   *
   * The panel comes back the way the clip was made — prompt, model, timing and
   * the reference stills — and the clip takes the video-reference slot, because
   * that is what the render is: the shot that starts where this one stopped.
   * The clip is then read two ways by the server: whole by the prompt model, and
   * cut to its last frames for H3.
   */
  async function continueFrame(frame: Frame) {
    if (!isVideoSrc(frame.src)) return;
    // Only the first arm parks the panel: arming a second clip is still inside
    // Continue, and the reference to go back to is the one from before it.
    // `reuseFrame` clears the parking slot on its way through, so the copy is
    // taken here and put back after it returns.
    const prior = continuation ? null : { clip: clipRef, prompt: videoPrompt, characters, background };
    await reuseFrame(frame, { mode: "video" });
    if (prior) continuePrior.current = prior;
    setVideoMode("video");
    setContinuation({ src: frame.src });

    try {
      // Same prep the asset picker uses, so the panel shows the clip it is
      // actually going to send.
      const media = await mediaFromSrc(frame.src, `continue-${frame.id}.mp4`, undefined, frame.seconds);
      setClipRef(media);
      setNotice("Continuing this clip.");
    } catch (cause) {
      setContinuation(undefined);
      setFailed(true);
      setStatus(cause instanceof Error ? cause.message : "That clip could not be read back.");
    }
  }

  /* --------------------------------- render --------------------------------- */

  const frames = project?.frames ?? [];
  const messages = project?.messages ?? [];
  // Derived once per frame list rather than per render: the selection bar's
  // position effect depends on this object, and a new identity every render
  // would make that effect run every render.
  const selectedFrame = useMemo(() => frames.find((frame) => frame.id === selected), [frames, selected]);
  const viewerFrame = useMemo(() => frames.find((frame) => frame.id === viewer), [frames, viewer]);
  const viewerIndex = viewerFrame ? frames.indexOf(viewerFrame) + 1 : 0;

  // The bar hugs the selected frame, clamped inside the canvas so an edge or a
  // corner cannot clip it. Measured rather than computed from a constant,
  // because its width changes with the label it shows (`Delete` / `Sure?`).
  useEffect(() => {
    const bar = selectionBarRef.current;
    const canvas = canvasRef.current;
    if (!selectedFrame || !bar || !canvas) {
      setBarPos(null);
      return;
    }

    const pad = 10;
    const barWidth = bar.offsetWidth;
    const barHeight = bar.offsetHeight;
    const centerX = view.x + (selectedFrame.x + FRAME_SIZE / 2) * view.zoom;
    const frameTop = view.y + selectedFrame.y * view.zoom;
    const frameBottom = frameTop + FRAME_SIZE * view.zoom;

    // Above the frame by default; below it when there is no room at the top.
    let top = frameTop - barHeight - 12;
    if (top < pad) top = frameBottom + 12;
    top = Math.min(Math.max(top, pad), Math.max(pad, canvas.clientHeight - barHeight - pad));

    const left = Math.min(
      Math.max(centerX, barWidth / 2 + pad),
      Math.max(barWidth / 2 + pad, canvas.clientWidth - barWidth / 2 - pad),
    );

    setBarPos((current) =>
      current && Math.abs(current.left - left) < 0.5 && Math.abs(current.top - top) < 0.5
        ? current
        : { left, top },
    );
  }, [selectedFrame, view, pendingDelete]);
  const canUndo = past.length > 0;
  const canRedo = future.length > 0;
  const zoomLabel = useMemo(() => `${Math.round(view.zoom * 100)}%`, [view.zoom]);

  const activeVideoModel = findVideoModel(videoModel) ?? DEFAULT_VIDEO_MODEL;
  const activeImageModel = findImageTool(imageModel) ?? DEFAULT_TOOL;
  const takesImageReferences =
    activeImageModel.references !== false && (activeImageModel.provider !== "local" || canvasEnabled);
  /**
   * How many reference stills this tool can take.
   *
   * The local edit graph's first image slot is the canvas, so it has one fewer
   * than the Router tool's flat list.
   */
  const maxImageReferences =
    activeImageModel.provider === "local" ? activeImageModel.maxBatch - 1 : MAX_IMAGE_REFERENCES;
  // The H3 card switches between three Router entries; everything else is one.
  const h3Tiers = h3TierModels();
  const h3ActiveTier = h3Tiers.find((tier) => tier.model.id === videoModel);
  const takesReferences = activeVideoModel.references !== false;
  const modeLocks = lockedByMode(videoMode);
  const unetStatus = verifyResult?.checked
    ? verifyResult.unet?.found === true
      ? "ok"
      : verifyResult.unet?.found === false
        ? "bad"
        : undefined
    : undefined;
  const clipStatus = verifyResult?.checked
    ? verifyResult.clip?.found === true
      ? "ok"
      : verifyResult.clip?.found === false
        ? "bad"
        : undefined
    : undefined;
  const verifyBanner =
    verifyResult && !verifyResult.checked
      ? { text: verifyResult.error ?? verifyResult.note ?? "Could not check this target.", bad: true }
      : verifyResult?.checked && verifyResult.note
        ? { text: verifyResult.note, bad: false }
        : null;
  // A continuation renders a new clip: its length is a fresh decision even
  // though it inherits the framing, and there is no trim window to edit because
  // the reference is used whole (only its last frames reach the model).
  const mediaRef = videoMode === "audio" ? audioRef : videoMode === "video" ? clipRef : undefined;
  const hasKeyframes = videoMode === "free" && Boolean(firstFrame || lastFrame);

  // Everything on the canvas is available to every slot. Frames are already
  // validated when the project loads, so this is just a projection.
  const renderAssets = useMemo(() => frames.map((frame, index) => renderAsset(frame, index)), [frames]);
  /** The still the share card shows; a generated clip cannot stand in as a cover. */
  const shareCover = useMemo(() => frames.find((frame) => !isVideoSrc(frame.src))?.src, [frames]);
  /** What the Assets tab counts: every file the library can offer. */
  const assetCount = uploads.length + renderAssets.length;
  const pickerKind: AssetKind | undefined =
    picker === null ? undefined : picker.slot === "audio" ? "audio" : picker.slot === "clip" ? "video" : "image";

  /** The picker hands back a prepared reference, so a slot is one assignment. */
  function applyPick(picked: PickedAsset) {
    const target = picker;
    if (!target) return;

    setNotice(undefined);
    setFailed(false);
    setStatus(undefined);

    if (picked.kind === "image") {
      if (target.slot === "first-frame") setFirstFrame(picked.reference);
      else if (target.slot === "last-frame") setLastFrame(picked.reference);
      else if (target.slot === "background") setBackground(picked.reference);
      else if (target.slot === "canvas") setCanvasImage(picked.reference);
      else if (target.slot === "reference") {
        setImageReferences((current) =>
          target.index === null
            ? [...current, picked.reference].slice(0, MAX_IMAGE_REFERENCES)
            : current.map((item, position) => (position === target.index ? picked.reference : item)),
        );
      } else if (target.slot === "character") {
        setCharacters((current) =>
          target.index === null
            ? [...current, picked.reference].slice(0, MAX_CHARACTERS)
            : current.map((item, position) => (position === target.index ? picked.reference : item)),
        );
      }
    } else if (picked.kind === "audio") {
      setAudioRef(picked.media);
      syncReferenceDuration(picked.media.seconds);
    } else {
      setClipRef(picked.media);
      syncReferenceDuration(picked.media.seconds);
    }

    setPicker(null);
  }

  /** A new reference sets the clip length, clamped to this model's range. */
  function syncReferenceDuration(seconds?: number) {
    if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return;
    setVideoDuration(clampDuration(Math.round(seconds), activeVideoModel));
  }

  // Characters are a list: an empty slot appears after each one, up to the cap.
  const referenceStrip = (
    <div className={`references${hasKeyframes ? " is-muted" : ""}`} title={hasKeyframes ? "Character and background references are unused while a first/last frame is set" : undefined}>
      {characters.map((reference, index) => (
        <ReferenceSlot
          key={`character-${index}`}
          kind="character"
          value={reference}
          disabled={busy}
          onChange={(next) => {
            setNotice(undefined);
            setCharacters((current) =>
              next
                ? current.map((item, position) => (position === index ? next : item))
                : current.filter((_, position) => position !== index),
            );
          }}
          onPick={() => setPicker({ slot: "character", index })}
        />
      ))}

      {characters.length < MAX_CHARACTERS && (
        <ReferenceSlot
          kind="character"
          disabled={busy}
          onChange={(next) => {
            if (!next) return;
            setNotice(undefined);
            setCharacters((current) => [...current, next].slice(0, MAX_CHARACTERS));
          }}
          onPick={() => setPicker({ slot: "character", index: null })}
        />
      )}

      <ReferenceSlot
        kind="background"
        value={background}
        disabled={busy}
        onChange={(next) => {
          setNotice(undefined);
          setBackground(next);
        }}
        onPick={() => setPicker({ slot: "background" })}
      />
    </div>
  );

  const imageReferenceSlot = (
    <div className="references">
      {imageReferences.map((reference, index) => (
        <ReferenceSlot
          key={`reference-${index}`}
          kind="reference"
          value={reference}
          disabled={busy}
          onChange={(next) => {
            setNotice(undefined);
            setImageReferences((current) =>
              next
                ? current.map((item, position) => (position === index ? next : item))
                : current.filter((_, position) => position !== index),
            );
          }}
          onPick={() => setPicker({ slot: "reference", index })}
        />
      ))}

      {imageReferences.length < maxImageReferences && (
        <ReferenceSlot
          kind="reference"
          disabled={busy}
          onChange={(next) => {
            if (!next) return;
            setNotice(undefined);
            setImageReferences((current) => [...current, next].slice(0, maxImageReferences));
          }}
          onPick={() => setPicker({ slot: "reference", index: null })}
        />
      )}
    </div>
  );

  const aiButton = (
    <button
      type="button"
      className={`ai-button${brain ? " is-on" : ""}`}
      onClick={() => setBrainOpen(true)}
      title="Choose the model that rewrites your prompt"
      aria-haspopup="dialog"
      disabled={busy}
    >
      <span className="ai-dot" aria-hidden="true" />
      <span className="ai-label">Flavor</span>
      <span className="ai-model">
        {brain ? BRAIN_OPTIONS.find((option) => option.id === brain)?.short ?? brain : "Off"}
      </span>
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
        <path d="M6 9l6 6 6-6" />
      </svg>
    </button>
  );

  const framesRef = useRef<Frame[]>([]);
  framesRef.current = frames;

  // Rotating a phone or resizing a window should re-frame the work rather than
  // leave it stranded under the panel.
  useEffect(() => {
    let timer = 0;
    const measure = () => setNarrow(window.innerWidth <= 900);
    measure();

    function onResize() {
      measure();
      window.clearTimeout(timer);
      timer = window.setTimeout(() => fit(framesRef.current), 160);
    }
    window.addEventListener("resize", onResize);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", onResize);
    };
  }, [fit]);

  if (loadError) {
    return (
      <main className="workspace-missing">
        <h1>Project not found</h1>
        <p>{loadError}</p>
        <Link className="primary" href="/">
          Back to projects
        </Link>
      </main>
    );
  }

  return (
    <main className="workspace">
      <div
        ref={canvasRef}
        className={`canvas${tool === "hand" ? " is-hand" : ""}`}
        onPointerDown={startPan}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={(event) => {
          // A frame's double-click opens the viewer; only empty canvas deselects.
          if ((event.target as HTMLElement).closest?.(".stage-frame")) return;
          setSelected(null);
        }}
      >
        <div
          className="canvas-world"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
        >
          {frames.map((frame, index) => (
            <div
              key={frame.id}
              className={`stage-frame${selected === frame.id ? " is-selected" : ""}`}
              style={{ width: FRAME_SIZE, height: FRAME_SIZE, transform: `translate(${frame.x}px, ${frame.y}px)` }}
              onPointerDown={(event) => startFrameDrag(event, frame)}
              title="Double-click to view full size"
            >
              {isVideoSrc(frame.src) ? (
                <video src={mediaUrl(frame.src)} autoPlay muted loop playsInline preload="metadata" />
              ) : (
                <img src={mediaUrl(frame.src)} alt={frame.prompt} draggable={false} />
              )}
              <span className="frame-index">{String(index + 1).padStart(2, "0")}</span>
              {(Boolean(frame.characterSrcs?.length) || Boolean(frame.backgroundSrc) || referenceCount(frame) > 0 || Boolean(frame.canvasSrc) || isVideoSrc(frame.src)) && (
                <span className="frame-flags">
                  {isVideoSrc(frame.src) && (
                    <span className="frame-flag" title="Generated clip">
                      <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor">
                        <path d="M8 5l11 7-11 7z" />
                      </svg>
                    </span>
                  )}
                  {referenceCount(frame) > 0 && (
                    <span
                      className="frame-flag"
                      title={`Rendered with ${referenceCount(frame)} reference image${referenceCount(frame) === 1 ? "" : "s"}`}
                    >
                      <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.2">
                        <rect x="3" y="5" width="18" height="14" rx="2.5" />
                        <circle cx="9" cy="10" r="1.6" />
                        <path d="M4 17l5-4 4 3 3-2 4 3" />
                      </svg>
                    </span>
                  )}
                  {frame.canvasSrc && (
                    <span className="frame-flag" title="Edited from a canvas image">
                      <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.2">
                        <path d="M4 20l4-1 11-11-3-3L5 16l-1 4z" />
                        <path d="M14 5l3 3" />
                      </svg>
                    </span>
                  )}
                  {Boolean(frame.characterSrcs?.length) && (
                    <span className="frame-flag" title="Rendered with a character reference">
                      <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.2">
                        <circle cx="12" cy="8" r="4" />
                        <path d="M20 21a8 8 0 0 0-16 0" />
                      </svg>
                    </span>
                  )}
                  {frame.backgroundSrc && (
                    <span className="frame-flag" title="Rendered with a background reference">
                      <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.2">
                        <rect x="3" y="4" width="18" height="16" rx="2.5" />
                        <path d="M4 17l5-4 4 3 3-2 4 3" />
                      </svg>
                    </span>
                  )}
                </span>
              )}
            </div>
          ))}

          {/* Renders in flight: a blueprint square holds the slot and fills from
              the bottom while the work is running. */}
          {pending.map((slot) => {
            const track = tracks[slot.id];
            const fraction = trackFraction(track);
            return (
              <div
                key={slot.id}
                className={`stage-frame is-pending${fraction !== undefined ? " is-tracked" : ""}`}
                data-kind={slot.kind}
                style={
                  {
                    width: FRAME_SIZE,
                    height: FRAME_SIZE,
                    transform: `translate(${slot.x}px, ${slot.y}px)`,
                    ...(fraction !== undefined ? { "--pending-progress": `${Math.round(fraction * 100)}%` } : {}),
                  } as React.CSSProperties
                }
                onPointerDown={(event) => startPendingDrag(event, slot)}
                title="Drag to place this render"
              >
                <span className="pending-label">
                  {track?.label ?? (slot.kind === "video" ? "Rendering clip…" : "Rendering still…")}
                </span>
                {track && <span className="pending-clock">{clock(track.elapsed)}</span>}
                <span className="pending-prompt">{slot.prompt}</span>
              </div>
            );
          })}        </div>

        {/* The hint is for an untouched canvas. A pending slot means a Generate
            press has already landed, so the ghost would only sit on top of the
            blueprint square while the render runs. */}
        {project && frames.length === 0 && pending.length === 0 && (
          <div className="canvas-empty">
            <div className="canvas-ghost" aria-hidden="true" />
            <p>Describe a frame or a clip in the panel to place your first result.</p>
          </div>
        )}

        {selectedFrame && (
          <div
            ref={selectionBarRef}
            className="selection-bar"
            onPointerDown={(event) => event.stopPropagation()}
            style={
              barPos ? { left: barPos.left, top: barPos.top } : { left: 0, top: 0, visibility: "hidden" }
            }
          >
            <button type="button" onClick={() => setViewer(selectedFrame.id)} title="View full size">
              View
            </button>
            <button
              type="button"
              onClick={() => void reuseFrame(selectedFrame)}
              title="Fill the panel with this frame's prompt and settings"
            >
              Reuse
            </button>
            {isVideoSrc(selectedFrame.src) && (
              <button
                type="button"
                onClick={() => void continueFrame(selectedFrame)}
                title="Continue this clip from where it stopped"
              >
                Continue
              </button>
            )}
            <a className="button-link" href={mediaUrl(selectedFrame.src)} download={`frame-${selectedFrame.id}.png`}>
              Download
            </a>
            <button
              type="button"
              className="danger"
              data-armed={pendingDelete === selectedFrame.id ? "true" : undefined}
              title={pendingDelete === selectedFrame.id ? "Press again to delete" : "Delete this frame"}
              onClick={() => requestDelete(selectedFrame.id)}
            >
              {pendingDelete === selectedFrame.id ? "Sure?" : "Delete"}
            </button>
          </div>
        )}
      </div>

      {/* Full-size view: the canvas frames are square cover crops, so a clip or
          a portrait still needs somewhere to be seen whole. */}
      {viewerFrame && (
        <div
          className="overlay viewer-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`Frame ${viewerIndex}`}
          onClick={() => setViewer(null)}
        >
          <div className="viewer" onClick={(event) => event.stopPropagation()}>
            <div className="viewer-media">
              {isVideoSrc(viewerFrame.src) ? (
                <video
                  key={viewerFrame.id}
                  src={mediaUrl(viewerFrame.src)}
                  controls
                  autoPlay
                  loop
                  playsInline
                  preload="metadata"
                />
              ) : (
                <img src={mediaUrl(viewerFrame.src)} alt={viewerFrame.prompt} draggable={false} />
              )}
            </div>

            <aside className="viewer-panel">
              <header>
                <span className="viewer-index">{String(viewerIndex).padStart(2, "0")}</span>
                <span className="viewer-kind">
                  {isVideoSrc(viewerFrame.src) ? "Clip" : "Still"}
                  {viewerFrame.seconds ? ` · ${viewerFrame.seconds}s` : ""}
                </span>
                <button
                  type="button"
                  className="viewer-close"
                  aria-label="Close viewer"
                  onClick={() => setViewer(null)}
                >
                  ✕
                </button>
              </header>

              {/* What the person typed. The rewrite lives in the metadata
                  below: that is what the model saw, not what they wrote. */}
              <p className="viewer-prompt">{viewerFrame.sourcePrompt?.trim() || viewerFrame.prompt}</p>
              {viewerFrame.prompt !== (viewerFrame.sourcePrompt?.trim() || viewerFrame.prompt) && (
                <details className="viewer-sent">
                  <summary>
                    Prompt sent{viewerFrame.enhanced ? " · rewritten" : ""}
                  </summary>
                  <p>{viewerFrame.prompt}</p>
                </details>
              )}

              <div className="viewer-meta">
                <span>{viewerFrame.model || "unknown model"}</span>
                {viewerFrame.recipe?.video && (
                  <span>{modeLabel(viewerFrame.recipe.video.mode)}</span>
                )}
                {viewerFrame.recipe?.video?.ratio && <span>{viewerFrame.recipe.video.ratio}</span>}
                {viewerFrame.recipe?.video?.resolution && (
                  <span>{resolutionLabel(viewerFrame.recipe.video.resolution)}</span>
                )}
                {viewerFrame.recipe?.video?.duration && (
                  <span>{viewerFrame.recipe.video.duration}s</span>
                )}
                {/* A clip's recipe already carries its own ratio and size. */}
                {!viewerFrame.recipe?.video && viewerFrame.recipe?.ratio && (
                  <span>{imageRatioLabel(findImageRatio(viewerFrame.recipe.ratio))}</span>
                )}
                {!viewerFrame.recipe?.video && viewerFrame.recipe?.resolution && (
                  <span>{imageResolutionLabel(findImageResolution(viewerFrame.recipe.resolution))}</span>
                )}
                {!viewerFrame.recipe?.video && (viewerFrame.recipe?.batch ?? 1) > 1 && (
                  <span>×{viewerFrame.recipe!.batch}</span>
                )}
                {viewerFrame.style && viewerFrame.style !== "none" && <span>{viewerFrame.style}</span>}
                {viewerFrame.recipe?.flavor && <span>{flavorLabel(viewerFrame.recipe.flavor)}</span>}
                {viewerFrame.canvasSrc && <span>Canvas</span>}
                {referenceCount(viewerFrame) > 0 && (
                  <span>
                    {referenceCount(viewerFrame) === 1 ? "Reference" : `${referenceCount(viewerFrame)} references`}
                  </span>
                )}
                {Boolean(viewerFrame.characterSrcs?.length) && (
                  <span>
                    {viewerFrame.characterSrcs!.length} character
                    {viewerFrame.characterSrcs!.length === 1 ? "" : "s"}
                  </span>
                )}
                {viewerFrame.backgroundSrc && <span>Background</span>}
              </div>

              <div className="viewer-actions">
                <a
                  className="button-link primary"
                  href={mediaUrl(viewerFrame.src)}
                  download={`frame-${viewerFrame.id}${isVideoSrc(viewerFrame.src) ? ".mp4" : ".png"}`}
                >
                  Download
                </a>
                <button
                  type="button"
                  onClick={() => void reuseFrame(viewerFrame)}
                  title="Fill the panel with this frame's prompt and settings"
                >
                  Reuse
                </button>
                {isVideoSrc(viewerFrame.src) && (
                  <button
                    type="button"
                    onClick={() => void continueFrame(viewerFrame)}
                    title="Continue this clip from where it stopped"
                  >
                    Continue
                  </button>
                )}
                <button
                  type="button"
                  className="danger"
                  data-armed={pendingDelete === viewerFrame.id ? "true" : undefined}
                  title={pendingDelete === viewerFrame.id ? "Press again to delete" : "Delete this frame"}
                  onClick={() => requestDelete(viewerFrame.id)}
                >
                  {pendingDelete === viewerFrame.id ? "Sure?" : "Delete"}
                </button>
              </div>
            </aside>
          </div>
        </div>
      )}

      {/* An attached reference, seen whole. Replace hands the slot back to
          the picker without clearing it first. */}
      {mediaView && (
        <div
          className="overlay viewer-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={mediaView.name}
          onClick={() => setMediaView(null)}
        >
          <div className="viewer" onClick={(event) => event.stopPropagation()}>
            <div className="viewer-media">
              {mediaView.kind === "video" ? (
                <video src={mediaView.src} controls autoPlay playsInline />
              ) : mediaView.kind === "audio" ? (
                <audio src={mediaView.src} controls autoPlay />
              ) : (
                <img src={mediaView.src} alt={mediaView.name} draggable={false} />
              )}
            </div>

            <aside className="viewer-panel">
              <header>
                <span className="viewer-index">
                  {mediaView.kind === "video" ? "Clip" : mediaView.kind === "audio" ? "Track" : "Still"}
                </span>
                <span className="viewer-kind">{mediaView.name}</span>
                <button
                  type="button"
                  className="viewer-close"
                  aria-label="Close viewer"
                  onClick={() => setMediaView(null)}
                >
                  ✕
                </button>
              </header>

              <div className="viewer-actions">
                {mediaView.onReplace && (
                  <button
                    type="button"
                    onClick={() => {
                      const replace = mediaView?.onReplace;
                      setMediaView(null);
                      replace?.();
                    }}
                  >
                    Replace
                  </button>
                )}
              </div>
            </aside>
          </div>
        </div>
      )}

      <header className="floating top-left">
        <Link href="/" className="icon-button" aria-label="All projects" title="All projects">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </Link>
        <input
          className="project-name"
          value={project?.name ?? ""}
          placeholder="Untitled project"
          maxLength={80}
          aria-label="Project name"
          disabled={!project}
          onChange={(event) =>
            setProject((current) =>
              current ? { ...current, name: event.target.value, updatedAt: Date.now() } : current,
            )
          }
          onBlur={(event) =>
            setProject((current) =>
              current ? { ...current, name: normalizeName(event.target.value) } : current,
            )
          }
        />
        <span className="save-dot" data-state={saveState} title={saveState === "error" ? "Not saved" : "Saved"}>
          {saveState === "saving" ? "saving" : saveState === "error" ? "unsaved" : savedAt ? "saved" : ""}
        </span>
        <button
          type="button"
          className="share"
          aria-haspopup="dialog"
          onClick={() => setShare({ url: window.location.href })}
        >
          Share
        </button>
      </header>

      <div className="top-right">
        <AccountMenu />
      </div>

      <aside className={`floating panel${tab === "chat" ? " is-chat" : ""}`}>
        <div className="panel-tabs" role="tablist" aria-label="Panel">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "create"}
            className={tab === "create" ? "is-active" : ""}
            onClick={() => setTab("create")}
          >
            Create
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "video"}
            className={tab === "video" ? "is-active" : ""}
            onClick={() => setTab("video")}
          >
            Video
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "chat"}
            className={tab === "chat" ? "is-active" : ""}
            onClick={() => setTab("chat")}
          >
            Chat
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "assets"}
            className={tab === "assets" ? "is-active" : ""}
            onClick={() => setTab("assets")}
          >
            Assets
            {assetCount > 0 && <span className="tab-count">{assetCount}</span>}
          </button>
        </div>

        {tab === "create" ? (
          <div className="panel-body">
            <div className="panel-row static">
              <span className="row-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7">
                  <rect x="3" y="5" width="18" height="14" rx="2.5" />
                  <circle cx="9" cy="10" r="1.6" />
                  <path d="M4 17l5-4 4 3 3-2 4 3" />
                </svg>
              </span>
              <span>Image</span>
            </div>

            <div className="panel-row image-model-row">
              {/* One hit target for the whole row; the Edit switch sits above it. */}
              <button
                type="button"
                className="image-model-hit"
                aria-label={`Choose an image model (${activeImageModel.label})`}
                aria-haspopup="dialog"
                onClick={() => setImageModelOpen(true)}
                disabled={busy}
              />

              <span className="row-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7">
                  <circle cx="12" cy="12" r="8" />
                  <path d="M12 4v3M12 17v3M4 12h3M17 12h3" />
                  <circle cx="12" cy="12" r="2" />
                </svg>
              </span>
              <span className="row-value">
                <span className="model-label">
                  {activeImageModel.label}
                  <ModelLogo brand="bfl" />
                </span>
              </span>

              <button
                type="button"
                role="switch"
                aria-checked={canvasEnabled}
                className={`edit-switch${canvasEnabled ? " is-on" : ""}`}
                onClick={() => setCanvasEnabled((current) => !current)}
                disabled={busy}
                title="Edit a canvas image"
              >
                <span className="edit-label">Edit</span>
                <span className="row-toggle" aria-hidden="true" />
              </button>

              <svg
                className="image-model-chevron"
                viewBox="0 0 24 24"
                width="12"
                height="12"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                aria-hidden="true"
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </div>

            {canvasEnabled && (
              <MediaSlot
                tag="Img"
                label="Add an image to edit"
                noun="canvas image"
                value={canvasImage ? { name: canvasImage.name, mb: canvasImage.mb } : undefined}
                preview={canvasImage?.preview}
                previewKind="image"
                viewSrc={canvasImage?.preview}
                viewKind="image"
                onView={
                  canvasImage
                    ? () =>
                        setMediaView({
                          src: canvasImage.preview,
                          kind: "image",
                          name: canvasImage.name,
                          mb: canvasImage.mb,
                          onReplace: () => setPicker({ slot: "canvas" }),
                        })
                    : undefined
                }
                disabled={busy}
                onPick={() => setPicker({ slot: "canvas" })}
                onClear={() => setCanvasImage(undefined)}
              />
            )}

            <div className="prompt-box">
              <textarea
                className="panel-prompt"
                value={prompt}
                rows={4}
                maxLength={900}
                placeholder={
                  canvasEnabled
                    ? "Describe the edit…"
                    : brain
                      ? "Describe image… AI will expand it"
                      : "Describe image…"
                }
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send(prompt);
                  }
                }}
              />

              <div className="prompt-footer">
                {takesImageReferences && imageReferenceSlot}
                {!canvasEnabled && aiButton}
              </div>
            </div>

            <div className="panel-chips">
              <ChipPicker
                heading="Aspect ratio"
                title="Aspect ratio"
                label={canvasEnabled ? "Auto" : imageRatioLabel(imageRatio)}
                value={imageRatio}
                locked={canvasEnabled}
                lockedHint="Set by the canvas image"
                disabled={busy}
                items={imageRatioOptions(activeImageModel).map((option) => ({
                  id: option.id,
                  label: option.label,
                  icon: <RatioIcon ratio={option} />,
                }))}
                onChange={(id) =>
                  setImageRatio(findImageRatio(id, activeImageModel.aspectRatio, activeImageModel.ratios))
                }
              />
              <ChipPicker
                heading="Resolution"
                title="Resolution"
                label={imageResolutionLabel(imageResolution)}
                value={imageResolution}
                disabled={busy}
                items={imageResolutionOptions(activeImageModel).map((option) => ({
                  id: option.id,
                  label: option.label,
                  icon: <ImageResolutionIcon resolution={option.id} />,
                }))}
                onChange={(id) =>
                  setImageResolution(findImageResolution(id, activeImageModel.resolution, activeImageModel.resolutions))
                }
              />
              <ChipPicker
                heading="Batch"
                title="Images per press"
                label={`×${imageBatch}`}
                value={String(imageBatch)}
                disabled={busy}
                items={imageBatchOptions(activeImageModel).map((count) => ({
                  id: String(count),
                  label: `×${count}`,
                }))}
                onChange={(id) => setImageBatch(clampImageBatch(id, activeImageModel.maxBatch))}
              />
              {/* Character and background references belong to the Video tab;
                  a still render sends imageReferences, never these. */}
            </div>

            <button
              type="button"
              className="generate"
              onClick={() => void send(prompt)}
              disabled={busy || !prompt.trim() || (canvasEnabled && !canvasImage)}
            >
              {busy ? "Working…" : "Generate"}
            </button>

            {(status || failed) && (
              <p className={`panel-status${failed ? " error" : ""}`} role="status">
                {status}
              </p>
            )}
            {notice && <p className="panel-status">{notice}</p>}
          </div>
        ) : tab === "video" ? (
          <div className="panel-body">
            <button
              type="button"
              className="panel-row"
              onClick={() => setVideoModelOpen(true)}
              disabled={busy}
              aria-haspopup="dialog"
            >
              <span className="row-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7">
                  <rect x="2.5" y="6" width="14" height="12" rx="2.5" />
                  <path d="M16.5 11l5-3v8l-5-3z" />
                </svg>
              </span>
              <span className="row-value">
                <span className="model-label">
                  {activeVideoModel.label}
                  <ModelLogo brand="minimax" />
                </span>
              </span>
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>

            <div className="mode-row">
              <span className="row-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7">
                  <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
                  <circle cx="16" cy="7" r="2.2" />
                  <circle cx="8" cy="17" r="2.2" />
                </svg>
              </span>
              <div className="mode-group" role="group" aria-label="Mode">
                {VIDEO_MODES.filter((mode) => !(continuation && mode.id === "video")).map((mode) => {
                  // While a continuation is armed it owns the video entry: one
                  // render cannot be both a reference pass and a continuation.
                  const active = !continuation && videoMode === mode.id;
                  return (
                    <button
                      key={mode.id}
                      type="button"
                      className={active ? "is-active" : ""}
                      aria-pressed={active}
                      disabled={busy || !activeVideoModel.modes.includes(mode.id)}
                      onClick={() => {
                        leaveContinuation();
                        setNotice(undefined);
                        setVideoMode(mode.id);
                        if (mode.id !== "free") {
                          setFirstFrame(undefined);
                          setLastFrame(undefined);
                        }
                      }}
                    >
                      {mode.label}
                    </button>
                  );
                })}
                {continuation && activeVideoModel.modes.includes("video") && (
                  <button
                    type="button"
                    className={`is-continue${videoMode === "video" ? " is-active" : ""}`}
                    aria-pressed={videoMode === "video"}
                    disabled={busy}
                    title="Extend this clip from where it stopped"
                    onClick={() => setVideoMode("video")}
                  >
                    Continue
                  </button>
                )}
              </div>
            </div>

            {videoMode === "free" ? (
              takesReferences && (
                <div className="media-split">
                  <MediaSlot
                    tag="In"
                    label="First frame"
                    noun="first frame"
                    compact
                    value={firstFrame}
                    preview={firstFrame?.preview}
                    previewKind="image"
                    viewSrc={firstFrame?.preview}
                    viewKind="image"
                    onView={
                      firstFrame
                        ? () =>
                            setMediaView({
                              src: firstFrame.preview,
                              kind: "image",
                              name: firstFrame.name,
                              mb: firstFrame.mb,
                              onReplace: () => setPicker({ slot: "first-frame" }),
                            })
                        : undefined
                    }
                    disabled={busy}
                    onPick={() => setPicker({ slot: "first-frame" })}
                    onClear={() => setFirstFrame(undefined)}
                  />

                  <MediaSlot
                    tag="Out"
                    label="Last frame"
                    noun="last frame"
                    compact
                    value={lastFrame}
                    preview={lastFrame?.preview}
                    previewKind="image"
                    viewSrc={lastFrame?.preview}
                    viewKind="image"
                    onView={
                      lastFrame
                        ? () =>
                            setMediaView({
                              src: lastFrame.preview,
                              kind: "image",
                              name: lastFrame.name,
                              mb: lastFrame.mb,
                              onReplace: () => setPicker({ slot: "last-frame" }),
                            })
                        : undefined
                    }
                    disabled={busy}
                    onPick={() => setPicker({ slot: "last-frame" })}
                    onClear={() => setLastFrame(undefined)}
                  />
                </div>
              )
            ) : (
              <div className="media-row">
                <MediaSlot
                  tag={videoMode === "audio" ? "Aud" : "Vid"}
                  label={videoMode === "audio" ? "Add an audio reference" : "Add a video reference"}
                  noun={videoMode === "audio" ? "audio reference" : "video reference"}
                  hint={
                    mediaRef
                      ? `${mediaRef.mb.toFixed(1)} MB · click to view`
                      : videoMode === "audio"
                        ? "MP3, WAV, M4A"
                        : "MP4, WebM"
                  }
                  value={mediaRef}
                  preview={videoMode === "video" ? mediaRef?.dataUrl : undefined}
                  previewKind="video"
                  viewSrc={mediaRef?.dataUrl}
                  viewKind={videoMode === "audio" ? "audio" : "video"}
                  onView={
                    mediaRef
                      ? () =>
                          setMediaView({
                            src: mediaRef.dataUrl,
                            kind: videoMode === "audio" ? "audio" : "video",
                            name: mediaRef.name,
                            mb: mediaRef.mb,
                            onReplace: () => setPicker({ slot: videoMode === "audio" ? "audio" : "clip" }),
                          })
                      : undefined
                  }
                  disabled={busy}
                  onPick={() => setPicker({ slot: videoMode === "audio" ? "audio" : "clip" })}
                  onClear={() => {
                    if (videoMode === "audio") {
                      setAudioRef(undefined);
                      return;
                    }
                    // Clearing the clip ends the continuation with it; there is
                    // nothing left to hand back to Video Reference.
                    continuePrior.current = null;
                    setClipRef(undefined);
                    setContinuation(undefined);
                  }}
                />

                {mediaRef && !continuation && (
                  <button
                    type="button"
                    className="trim-button"
                    onClick={() => setTrimOpen(true)}
                    title={`Clip length · ${activeVideoModel.minDuration}–${activeVideoModel.maxDuration}s`}
                    aria-haspopup="dialog"
                  >
                    {videoDuration}s
                  </button>
                )}
              </div>
            )}

            <div className="prompt-box">
              <textarea
                className="panel-prompt"
                value={videoPrompt}
                rows={4}
                maxLength={900}
                placeholder="Describe the shot…"
                onChange={(event) => setVideoPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void sendVideo();
                  }
                }}
              />

              <div className="prompt-footer">
                {takesReferences && referenceStrip}
                {/* Reference clips are always rewritten, and by which model is
                    the account's business — not the studio's. */}
                {videoMode === "free" && aiButton}
              </div>
            </div>

            <div className="panel-chips">
              <ChipPicker
                heading="Aspect ratio"
                title="Aspect ratio"
                label={videoRatioLabel(videoRatio)}
                value={videoRatio}
                locked={modeLocks.ratio}
                lockedHint="Set by the reference clip"
                disabled={busy}
                items={ratioOptions(activeVideoModel).map((option) => ({
                  id: option.id,
                  label: option.label,
                  icon: <RatioIcon ratio={option} />,
                }))}
                onChange={setVideoRatio}
              />
              <ChipPicker
                heading="Duration"
                title={`Clip length · ${activeVideoModel.minDuration}–${activeVideoModel.maxDuration}s`}
                label={`${videoDuration}s`}
                value={String(videoDuration)}
                locked={modeLocks.duration && !continuation}
                lockedHint={
                  videoMode === "audio"
                    ? "Set by the audio reference. Edit its trim window"
                    : "Set by the reference clip. Edit its trim window"
                }
                disabled={busy}
                items={durationOptions(activeVideoModel).map((seconds) => ({
                  id: String(seconds),
                  label: `${seconds}s`,
                }))}
                onChange={(id) => setVideoDuration(clampDuration(Number(id), activeVideoModel))}
              />
              <ChipPicker
                heading="Resolution"
                title="Resolution"
                label={videoResolutionLabel(videoResolution)}
                value={videoResolution}
                disabled={busy}
                items={resolutionOptions(activeVideoModel).map((option) => ({
                  id: option.id,
                  label: option.label,
                  note: option.note,
                  icon: <ResolutionIcon resolution={option.id} />,
                }))}
                onChange={(id) => setVideoResolution(findVideoResolution(id))}
              />
              {characters.length > 0 && !hasKeyframes && (
                <span className="chip static">
                  {characters.length} character{characters.length === 1 ? "" : "s"}
                </span>
              )}
              {background && !hasKeyframes && <span className="chip static">Background</span>}
              {firstFrame && <span className="chip static">First frame</span>}
              {lastFrame && <span className="chip static">Last frame</span>}
            </div>

            <button
              type="button"
              className="generate"
              onClick={() => void sendVideo()}
              disabled={busy || (videoMode === "free" && !videoPrompt.trim())}
            >
              {busy ? "Rendering…" : "Generate clip"}
            </button>

            {(status || failed) && (
              <p className={`panel-status${failed ? " error" : ""}`} role="status">
                {status}
              </p>
            )}
            {notice && <p className="panel-status">{notice}</p>}
          </div>
        ) : tab === "assets" ? (
          <AssetLibrary
            uploads={uploads}
            renders={renderAssets}
            liked={liked}
            pending={pending}
            busy={busy}
            onUpload={(asset) => setUploads((current) => addUpload(current, asset))}
            onToggleLike={(id) => setLiked((current) => toggleLiked(current, id))}
          />
        ) : (
          <div className="panel-body chat">
            <div className="chat-log" ref={chatLogRef}>
              {messages.length === 0 && (
                <p className="chat-empty">Ask anything, or tell me what to set up.</p>
              )}
              {messages.map((message) => (
                <div key={message.id} className={`chat-message ${message.role}`}>
                  <p>{message.text}</p>
                  <time>{relativeTime(message.createdAt)}</time>
                </div>
              ))}
            </div>

            <div className="chat-compose">
              <textarea
                value={chatDraft}
                rows={1}
                maxLength={900}
                placeholder="Message…"
                onChange={(event) => setChatDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    const value = chatDraft;
                    setChatDraft("");
                    void sendChat(value);
                  }
                }}
              />
              <button
                type="button"
                className="send"
                aria-label="Send"
                disabled={busy || !chatDraft.trim()}
                onClick={() => {
                  const value = chatDraft;
                  setChatDraft("");
                  void sendChat(value);
                }}
              >
                ↑
              </button>
            </div>
            {failed && status && <p className="panel-status error">{status}</p>}
          </div>
        )}
      </aside>

      <div className="floating dock">
        <CanvasTools
          tool={tool}
          onTool={setTool}
          zoomLabel={zoomLabel}
          onZoom={zoomBy}
          onFit={() => fit(frames)}
          onUndo={undo}
          onRedo={redo}
          canUndo={canUndo}
          canRedo={canRedo}
        />
      </div>

      <div className="floating dock-frames">
        {clipSeconds(frames) > 0 ? (
          <>
            <span>{clipSeconds(frames)}s</span> of clip
            {frames.length > 1 && <em>· {frames.length} items</em>}
          </>
        ) : (
          <>
            <span>{frames.length}</span> {frames.length === 1 ? "still" : "stills"}
          </>
        )}
      </div>

      {picker && pickerKind && (
        <AssetPicker
          kind={pickerKind}
          title={PICKER_COPY[picker.slot]}
          uploads={uploads}
          renders={renderAssets}
          liked={liked}
          busy={busy}
          onClose={() => setPicker(null)}
          onPick={applyPick}
          onUpload={(asset) => setUploads((current) => addUpload(current, asset))}
          onToggleLike={(id) => setLiked((current) => toggleLiked(current, id))}
        />
      )}

      {share && (
        <ShareModal
          name={project?.name ?? ""}
          url={share.url}
          count={frames.length}
          cover={shareCover}
          onClose={() => setShare(null)}
        />
      )}

      {trimOpen && mediaRef && (
        <TrimModal
          kind={videoMode === "audio" ? "audio" : "video"}
          media={mediaRef}
          minDuration={activeVideoModel.minDuration}
          maxDuration={activeVideoModel.maxDuration}
          duration={videoDuration}
          onClose={() => setTrimOpen(false)}
          onApply={({ duration, trimmed }) => {
            setVideoDuration(duration);
            if (trimmed && videoMode === "audio") setAudioRef(trimmed);
            setTrimOpen(false);
          }}
        />
      )}

      {videoModelOpen && (
        <div
          className="overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Choose a video model"
          onClick={() => setVideoModelOpen(false)}
        >
          <div className="modal model-panel" onClick={(event) => event.stopPropagation()}>
            <header>
              <h2>Video model</h2>
              <button type="button" aria-label="Close video model picker" onClick={() => setVideoModelOpen(false)}>
                ✕
              </button>
            </header>

            <p className="model-intro">The model responsible for rendering video clips.</p>

            <ul className="model-list" role="group" aria-label="Video model">
              {/* One card for the H3 family: the toggle in it picks the tier,
                  and the note describes whichever tier is selected. */}
              <li>
                <div className={`model-option is-family${h3ActiveTier ? " is-active" : ""}`}>
                  <span className="model-text">
                    <span className="model-name">
                      {h3Tiers[0]?.model.family ?? "MiniMax H3"}
                      <ModelLogo brand="minimax" />
                      <span className="model-provider">{h3ActiveTier?.model.id ?? h3Tiers[0]?.model.id}</span>
                    </span>
                    <span className="model-note">{h3ActiveTier?.model.note ?? h3Tiers[0]?.model.note}</span>
                    <span className="model-tiers" role="group" aria-label="H3 tier">
                      {h3Tiers.map((tier) => (
                        <button
                          key={tier.id}
                          type="button"
                          className={videoModel === tier.model.id ? "is-active" : ""}
                          aria-pressed={videoModel === tier.model.id}
                          disabled={busy}
                          onClick={() => setVideoModel(tier.model.id)}
                        >
                          {tier.label}
                        </button>
                      ))}
                    </span>
                  </span>
                  {h3ActiveTier && <CheckMark />}
                </div>
              </li>

              {standaloneVideoModels().map((option) => (
                <li key={option.id} className={option.provider === "local" ? "has-gear" : undefined}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={videoModel === option.id}
                    className={`model-option${videoModel === option.id ? " is-active" : ""}${
                      option.provider === "local" ? " has-config" : ""
                    }`}
                    onClick={() => {
                      setVideoModel(option.id);
                      setVideoModelOpen(false);
                    }}
                  >
                    <span className="model-text">
                      <span className="model-name">
                        {option.label}
                        <ModelLogo brand="minimax" />
                        <span className="model-provider">{option.id}</span>
                      </span>
                      <span className="model-note">{option.note}</span>
                    </span>
                    {videoModel === option.id && <CheckMark />}
                  </button>
                  {option.provider === "local" && (
                    <button
                      type="button"
                      className="model-gear"
                      title="Model, clip and steps"
                      aria-label="Configure MiniMax H3 Local"
                      onClick={openLocalConfig}
                    >
                      <SlidersIcon />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {imageModelOpen && (
        <div
          className="overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Choose an image model"
          onClick={() => setImageModelOpen(false)}
        >
          <div className="modal model-panel" onClick={(event) => event.stopPropagation()}>
            <header>
              <h2>Image model</h2>
              <button type="button" aria-label="Close image model picker" onClick={() => setImageModelOpen(false)}>
                ✕
              </button>
            </header>

            <p className="model-intro">The model responsible for rendering stills.</p>

            <ul className="model-list" role="group" aria-label="Image model">
              {TOOLS.map((option) => (
                <li key={option.id} className={option.provider === "local" ? "has-gear" : undefined}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={imageModel === option.id}
                    className={`model-option${imageModel === option.id ? " is-active" : ""}${
                      option.provider === "local" ? " has-config" : ""
                    }`}
                    onClick={() => {
                      setImageModel(option.id);
                      setImageModelOpen(false);
                    }}
                  >
                    <span className="model-text">
                      <span className="model-name">
                        {option.label}
                        <ModelLogo brand="bfl" />
                        <span className="model-provider">{option.id}</span>
                      </span>
                      <span className="model-note">{option.note}</span>
                    </span>
                    {imageModel === option.id && <CheckMark />}
                  </button>
                  {option.provider === "local" && (
                    <button
                      type="button"
                      className="model-gear"
                      title="Model, text encoder and steps"
                      aria-label="Configure FLUX 3 Local"
                      onClick={() => {
                        setImageModelOpen(false);
                        setImageConfigOpen(true);
                      }}
                    >
                      <SlidersIcon />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {imageConfigOpen &&
        createPortal(
          <LocalImageConfigDialog
            autoVerify={imageConfigAutoVerify}
            onClose={() => {
              setImageConfigOpen(false);
              setImageConfigAutoVerify(false);
            }}
          />,
          document.body,
        )}

      {localConfigOpen &&
        createPortal(
          <div
            className="overlay"
            role="dialog"
            aria-modal="true"
            aria-label="Configure MiniMax H3 Local"
            onClick={() => setLocalConfigOpen(false)}
          >
            <div className="modal account-modal model-config" onClick={(event) => event.stopPropagation()}>
              <header>
                <h2>MiniMax H3 Local</h2>
                <button
                  type="button"
                  className="account-verify"
                  onClick={() => void verifyLocalConfig()}
                  disabled={localBusy || verifying || !localDraft.unet.trim() || !localDraft.clip.trim()}
                >
                  {verifying ? "Checking…" : "Verify"}
                </button>
                <button type="button" aria-label="Close configuration" onClick={() => setLocalConfigOpen(false)}>
                  ✕
                </button>
              </header>

              {verifyBanner && (
                <p className={`verify-banner${verifyBanner.bad ? " is-bad" : ""}`} role="status">
                  {verifyBanner.text}
                </p>
              )}

              <form className="account-form" onSubmit={saveLocalConfig}>
                <label htmlFor="local-unet">Model name</label>
                <div className="field">
                  <input
                    id="local-unet"
                    className={unetStatus === "ok" ? "is-ok" : unetStatus === "bad" ? "is-bad" : undefined}
                    value={localDraft.unet}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="fasth3_omniref_8step_pruned_int8_convrot.safetensors"
                    disabled={localBusy}
                    onChange={(event) => {
                      setVerifyResult(null);
                      setLocalDraft((current) => ({ ...current, unet: event.target.value }));
                    }}
                  />
                  {unetStatus && (
                    <span className={`field-mark ${unetStatus}`} aria-hidden="true">
                      {unetStatus === "ok" ? "✓" : "✗"}
                    </span>
                  )}
                </div>

                <label htmlFor="local-clip">Clip model name</label>
                <div className="field">
                  <input
                    id="local-clip"
                    className={clipStatus === "ok" ? "is-ok" : clipStatus === "bad" ? "is-bad" : undefined}
                    value={localDraft.clip}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"
                    disabled={localBusy}
                    onChange={(event) => {
                      setVerifyResult(null);
                      setLocalDraft((current) => ({ ...current, clip: event.target.value }));
                    }}
                  />
                  {clipStatus && (
                    <span className={`field-mark ${clipStatus}`} aria-hidden="true">
                      {clipStatus === "ok" ? "✓" : "✗"}
                    </span>
                  )}
                </div>

                <label htmlFor="local-steps">Steps</label>
                <input
                  id="local-steps"
                  type="number"
                  min={1}
                  max={200}
                  value={localDraft.steps}
                  disabled={localBusy}
                  onChange={(event) => setLocalDraft((current) => ({ ...current, steps: event.target.value }))}
                />

                <label htmlFor="local-ref-video">Video reference cap</label>
                <select
                  id="local-ref-video"
                  value={localDraft.refVideoEdge}
                  disabled={localBusy}
                  onChange={(event) => setLocalDraft((current) => ({ ...current, refVideoEdge: event.target.value }))}
                >
                  {REF_VIDEO_EDGES.map((edge) => (
                    <option key={edge} value={edge}>
                      {edge === 0 ? "Match output" : `Up to ${edge}p`}
                    </option>
                  ))}
                </select>

                {localError && (
                  <p className="account-error" role="alert">
                    {localError}
                  </p>
                )}

                <div className="account-actions">
                  <button type="button" className="account-cancel" onClick={() => setLocalConfigOpen(false)}>
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="account-save"
                    disabled={
                      localBusy || !localDraft.unet.trim() || !localDraft.clip.trim() || !localDraft.steps.trim()
                    }
                  >
                    {localBusy ? "Saving…" : "Save"}
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body,
        )}

      {brainOpen && (
        <div
          className="overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Choose a flavor"
          onClick={() => setBrainOpen(false)}
        >
          <div className="modal model-panel" onClick={(event) => event.stopPropagation()}>
            <header>
              <h2>Flavor</h2>
              <button type="button" aria-label="Close model picker" onClick={() => setBrainOpen(false)}>
                ✕
              </button>
            </header>

            <p className="model-intro">Choose the Prompt Enhancer model.</p>

            <ul className="model-list" role="radiogroup" aria-label="Flavor model">
              <li>
                <button
                  type="button"
                  role="radio"
                  aria-checked={brain === null}
                  className={`model-option${brain === null ? " is-active" : ""}`}
                  onClick={() => {
                    setBrain(null);
                    setBrainOpen(false);
                  }}
                >
                  <span className="model-text">
                    <span className="model-name">Off</span>
                  </span>
                  {brain === null && <CheckMark />}
                </button>
              </li>

              {FLAVOR_MODELS.map((option) => (
                <li key={option.id}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={brain === option.id}
                    className={`model-option${brain === option.id ? " is-active" : ""}`}
                    onClick={() => {
                      setBrain(option.id);
                      setBrainOpen(false);
                    }}
                  >
                    <span className="model-text">
                      <span className="model-name">
                        {option.label}
                        <span className={`model-provider ${option.provider}`}>{option.provider}</span>
                      </span>
                    </span>
                    {brain === option.id && <CheckMark />}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </main>
  );
}

function CheckMark() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.6" aria-hidden="true">
      <path d="M4 12.5l5 5L20 6.5" />
    </svg>
  );
}

function SlidersIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M4 7h7M18 7h2M4 17h2M13 17h7" strokeLinecap="round" />
      <circle cx="14.5" cy="7" r="2.2" />
      <circle cx="9.5" cy="17" r="2.2" />
    </svg>
  );
}

/**
 * The rectangle on a ratio button, drawn at the option's own shape inside a
 * 20×20 box — portrait tall, landscape wide, and a stacked-pages glyph for
 * Auto, which has no shape to show.
 */
/**
 * A 16:9 screen drawn at three sizes, so 480p, 1k and 2K read as
 * smaller, bigger, biggest at a glance.
 */
function ResolutionIcon({ resolution }: { resolution: VideoResolution }) {
  const sizes: Record<VideoResolution, number> = { "480P": 11.6, "768P": 15.2, "2K": 18.65 };
  const box = sizes[resolution] ?? 18.65;
  const width = box;
  const height = box * (9 / 16);
  const x = (20 - width) / 2;
  const y = (20 - height) / 2;

  return (
    <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.35" aria-hidden="true">
      <rect x={x} y={y} width={width} height={height} rx="2.325" />
    </svg>
  );
}

function RatioIcon({ ratio }: { ratio: { id: string; w: number; h: number } }) {
  if (ratio.id === "adaptive" || ratio.id === "auto") {
    return (
      <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.35" aria-hidden="true">
        <rect x="1.6" y="4.2" width="11.2" height="14.2" rx="2.1" />
        <path d="M15.1 2.4h1.3a2.1 2.1 0 0 1 2.1 2.1v11.2a2.1 2.1 0 0 1-2.1 2.1h-1.3" />
      </svg>
    );
  }

  const box = 18.65;
  const scale = ratio.w / ratio.h;
  const width = scale >= 1 ? box : box * scale;
  const height = scale >= 1 ? box / scale : box;
  const x = (20 - width) / 2;
  const y = (20 - height) / 2;

  return (
    <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.35" aria-hidden="true">
      <rect x={x} y={y} width={width} height={height} rx="2.325" />
    </svg>
  );
}

/** A square drawn at five sizes, so the size classes read as a scale. */
function ImageResolutionIcon({ resolution }: { resolution: ImageResolution }) {
  const sizes: Record<ImageResolution, number> = {
    "768sq": 10,
    "1k": 12,
    "1.5k": 14,
    "2k": 16,
    "4k": 18.65,
  };
  const box = sizes[resolution] ?? 12;
  const x = (20 - box) / 2;
  const y = (20 - box) / 2;

  return (
    <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.35" aria-hidden="true">
      <rect x={x} y={y} width={box} height={box} rx="2.325" />
    </svg>
  );
}
