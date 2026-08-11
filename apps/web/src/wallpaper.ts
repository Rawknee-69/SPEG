import {
  createManagedThemeColors,
  getDefaultThemeColors,
  getThemeColorVariable,
  getThemeColorsForMode,
  getThemeDefinition,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeColors,
} from "./themePalette";

/**
 * Wallpaper ("background media") support: a fixed full-screen image, GIF, or
 * video behind a translucent app, plus optional accent extraction from the
 * media. The media bytes live in IndexedDB (video/GIF can exceed
 * localStorage quotas); only the small settings object is kept in
 * localStorage. Surface translucency is applied purely in CSS
 * (html[data-wallpaper]) so the runtime never rewrites theme colors for the
 * common case; the accent family is regenerated in JS only when the user
 * opts into "match accent to media".
 */

export const WALLPAPER_STORAGE_KEY = "speg:wallpaper:v1";
export const WALLPAPER_DB_NAME = "speg-wallpaper";
export const WALLPAPER_DB_STORE = "media";
export const WALLPAPER_MAX_VIDEO_BYTES = 80 * 1024 * 1024;
export const WALLPAPER_MAX_GIF_BYTES = 40 * 1024 * 1024;
export const WALLPAPER_MIN_DIM = 0;
export const WALLPAPER_MAX_DIM = 80;
export const WALLPAPER_MIN_BLUR = 0;
export const WALLPAPER_MAX_BLUR = 24;
/** Lowest allowed background-video playback rate (FPS). */
export const WALLPAPER_MIN_FPS = 24;
/** Absolute hard cap for the stored fps value; the UI clamps to the monitor's
    refresh rate, which can be lower (60/90/120/144/165/240). */
export const WALLPAPER_MAX_FPS = 240;

export type WallpaperKind = "image" | "gif" | "video";

export type WallpaperSettings = Readonly<{
  /** Media blob id in the wallpaper IndexedDB store. */
  id: string;
  kind: WallpaperKind;
  /** 0-80: percent of a black dim overlay behind the app content. */
  dim: number;
  /** 0-24: gaussian blur (px) applied to the media itself. */
  blur: number;
  /** 24-240: background-video playback rate in frames per second. The layer
      throttles canvas sampling to this rate; the UI clamps it to the monitor's
      refresh rate. Ignored for image/GIF wallpapers. */
  fps: number;
  /** Regenerate the theme accent family from the media's dominant color. */
  extractAccent: boolean;
}>;

export const WALLPAPER_DEFAULTS: Readonly<Omit<WallpaperSettings, "id" | "kind">> = {
  dim: 30,
  blur: 0,
  fps: 60,
  extractAccent: true,
};

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function parseWallpaperSettings(value: unknown): WallpaperSettings | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0) return null;
    const kind = record.kind;
    if (kind !== "image" && kind !== "gif" && kind !== "video") return null;
    return {
      id: record.id,
      kind,
      dim: clampInteger(record.dim, WALLPAPER_DEFAULTS.dim, WALLPAPER_MIN_DIM, WALLPAPER_MAX_DIM),
      blur: clampInteger(
        record.blur,
        WALLPAPER_DEFAULTS.blur,
        WALLPAPER_MIN_BLUR,
        WALLPAPER_MAX_BLUR,
      ),
      fps: clampInteger(record.fps, WALLPAPER_DEFAULTS.fps, WALLPAPER_MIN_FPS, WALLPAPER_MAX_FPS),
      extractAccent: record.extractAccent !== false,
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Settings storage + subscription (mirrors the theme store pattern)  */
/* ------------------------------------------------------------------ */

let wallpaperListeners: Array<() => void> = [];
let lastWallpaper: WallpaperSettings | null | undefined;
let wallpaperSnapshotStale = true;

function notifyWallpaperListeners() {
  wallpaperSnapshotStale = true;
  for (const listener of wallpaperListeners) listener();
}

export function readWallpaper(): WallpaperSettings | null {
  if (!wallpaperSnapshotStale && lastWallpaper !== undefined) return lastWallpaper;
  wallpaperSnapshotStale = false;
  if (typeof window === "undefined") {
    lastWallpaper = null;
    return null;
  }
  try {
    lastWallpaper = parseWallpaperSettings(window.localStorage.getItem(WALLPAPER_STORAGE_KEY));
  } catch {
    lastWallpaper = null;
  }
  return lastWallpaper;
}

export function writeWallpaper(settings: WallpaperSettings | null): void {
  if (typeof window === "undefined") return;
  if (settings === null) {
    window.localStorage.removeItem(WALLPAPER_STORAGE_KEY);
  } else {
    window.localStorage.setItem(WALLPAPER_STORAGE_KEY, JSON.stringify(settings));
  }
  lastWallpaper = settings;
  wallpaperSnapshotStale = true;
  notifyWallpaperListeners();
}

export function subscribeWallpaper(listener: () => void): () => void {
  wallpaperListeners.push(listener);
  if (typeof window !== "undefined") {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === WALLPAPER_STORAGE_KEY || event.key === null) {
        lastWallpaper = undefined;
        notifyWallpaperListeners();
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => {
      wallpaperListeners = wallpaperListeners.filter((entry) => entry !== listener);
      window.removeEventListener("storage", handleStorage);
    };
  }
  return () => {
    wallpaperListeners = wallpaperListeners.filter((entry) => entry !== listener);
  };
}

/* ------------------------------------------------------------------ */
/* IndexedDB media store                                               */
/* ------------------------------------------------------------------ */

let wallpaperDbPromise: Promise<IDBDatabase> | null = null;

function openWallpaperDb(): Promise<IDBDatabase> {
  if (wallpaperDbPromise) return wallpaperDbPromise;
  wallpaperDbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available in this environment."));
      return;
    }
    const request = indexedDB.open(WALLPAPER_DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(WALLPAPER_DB_STORE)) {
        request.result.createObjectStore(WALLPAPER_DB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open wallpaper store."));
  });
  wallpaperDbPromise.catch(() => {
    wallpaperDbPromise = null; // Allow a retry after a transient failure.
  });
  return wallpaperDbPromise;
}

function wallpaperDbRequest<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openWallpaperDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(WALLPAPER_DB_STORE, mode);
        const request = run(transaction.objectStore(WALLPAPER_DB_STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () =>
          reject(request.error ?? new Error("Wallpaper store request failed."));
        transaction.onabort = () =>
          reject(transaction.error ?? new Error("Wallpaper store transaction aborted."));
      }),
  );
}

export function putWallpaperMedia(id: string, blob: Blob): Promise<void> {
  return wallpaperDbRequest("readwrite", (store) => store.put(blob, id)).then(() => undefined);
}

export function getWallpaperMedia(id: string): Promise<Blob | null> {
  return wallpaperDbRequest("readonly", (store) => store.get(id)) as Promise<Blob | null>;
}

export function deleteWallpaperMedia(id: string): Promise<void> {
  return wallpaperDbRequest("readwrite", (store) => store.delete(id)).then(() => undefined);
}

/* ------------------------------------------------------------------ */
/* Color helpers + accent extraction                                  */
/* ------------------------------------------------------------------ */

export function hexToRgb(hex: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return null;
  const value = Number.parseInt(match[1]!, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

export function rgbToHex(rgb: readonly [number, number, number]): string {
  const channel = (value: number) =>
    Math.min(255, Math.max(0, Math.round(value)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`;
}

export function hexToRgbaString(hex: string, alpha: number): string | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

/** Convert a pixel into [hueDegrees, saturation, relativeValue] for accent bucketing. */
function rgbToHsv(rgb: readonly [number, number, number]): [number, number, number] {
  const r = rgb[0] / 255;
  const g = rgb[1] / 255;
  const b = rgb[2] / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  if (delta > 0) {
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
    if (hue < 0) hue += 360;
  }
  const saturation = max === 0 ? 0 : delta / max;
  return [hue, saturation, max];
}

/**
 * Pick a dominant, saturated accent from downsampled RGB samples. Samples are
 * bucketed by hue, weighted by saturation, and the most vivid bucket's
 * average color wins. Returns null for near-neutral media (the caller then
 * keeps the theme's own accent).
 */
export function samplesToAccent(
  samples: ReadonlyArray<readonly [number, number, number]>,
): string | null {
  const BUCKETS = 12;
  const sums = Array.from({ length: BUCKETS }, () => ({
    r: 0,
    g: 0,
    b: 0,
    count: 0,
    saturation: 0,
  }));
  for (const sample of samples) {
    const [hue, saturation] = rgbToHsv(sample);
    if (saturation < 0.18) continue; // Skip near-gray pixels.
    const bucket = sums[Math.min(BUCKETS - 1, Math.max(0, Math.floor(hue / 30)))]!;
    bucket.r += sample[0];
    bucket.g += sample[1];
    bucket.b += sample[2];
    bucket.count += 1;
    bucket.saturation += saturation;
  }
  let best: (typeof sums)[number] | null = null;
  let bestScore = 0;
  for (const bucket of sums) {
    if (bucket.count === 0) continue;
    // Vivid + abundant: a saturated sky wins over a sparse neon streak.
    const score = bucket.saturation * Math.sqrt(bucket.count);
    if (score > bestScore) {
      bestScore = score;
      best = bucket;
    }
  }
  if (!best) return null;
  const meanSaturation = best.saturation / best.count;
  if (meanSaturation < 0.22) return null;
  return rgbToHex([best.r / best.count, best.g / best.count, best.b / best.count]);
}

/**
 * Extract a candidate accent from an image or a video's current frame by
 * painting a 64px-wide sample and quantizing it. Runs once per media change,
 * never on the render loop.
 */
export function extractWallpaperAccent(source: HTMLImageElement | HTMLVideoElement): string | null {
  if (typeof document === "undefined") return null;
  const naturalWidth = "videoWidth" in source ? source.videoWidth : source.naturalWidth;
  const naturalHeight = "videoHeight" in source ? source.videoHeight : source.naturalHeight;
  if (!naturalWidth || !naturalHeight) return null;
  const width = 64;
  const height = Math.max(1, Math.round((width * naturalHeight) / naturalWidth));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  try {
    context.drawImage(source, 0, 0, width, height);
  } catch {
    return null;
  }
  let pixels: Uint8ClampedArray;
  try {
    pixels = context.getImageData(0, 0, width, height).data;
  } catch {
    return null;
  }
  const samples: Array<[number, number, number]> = [];
  for (let i = 0; i < pixels.length; i += 16) {
    samples.push([pixels[i]!, pixels[i + 1]!, pixels[i + 2]!]);
  }
  return samplesToAccent(samples);
}

/* ------------------------------------------------------------------ */
/* Applying the wallpaper to the document                             */
/* ------------------------------------------------------------------ */

/** Roles whose semantic tokens turn translucent over the wallpaper (CSS). */
const WALLPAPER_TRANSLUCENT_ROLES: ReadonlyArray<ThemeColorRole> = [
  "canvas",
  "chrome",
  "toolbar",
  "surface",
  "surfaceRaised",
  "surfaceOverlay",
  "sidebar",
  "codeBackground",
  "terminalBackground",
  "messageSurface",
];

/** Roles regenerated from the extracted accent (opaque; readable over media). */
const WALLPAPER_ACCENT_ROLES: ReadonlyArray<ThemeColorRole> = [
  "focus",
  "accent",
  "accentForeground",
  "accentSurface",
  "accentSurfaceForeground",
  "secondary",
  "secondaryForeground",
  "muted",
  "mutedForeground",
  "messageAction",
  "messageActionForeground",
  "messageActionHover",
  "update",
  "updateForeground",
  "updateSurface",
  "border",
  "input",
  "toolbarControl",
  "toolbarControlForeground",
  "toolbarControlHover",
  "toolbarBorder",
  "sidebarRowHover",
  "sidebarRowActive",
  "sidebarRowSelected",
  "sidebarControlSurface",
];

function resolveActiveThemeColors(appearance: ThemeAppearance): ThemeColors {
  const themeId =
    typeof document === "undefined" ? undefined : document.documentElement.dataset.themeId;
  const definition = themeId ? getThemeDefinition(themeId) : null;
  return (
    (definition ? (getThemeColorsForMode(definition, appearance) ?? definition.colors) : null) ??
    getDefaultThemeColors(appearance)
  );
}

/** Rewrite the theme's own accent family, undoing any regenerated overrides. */
function restoreThemeAccentRoles(appearance: ThemeAppearance): void {
  const colors = resolveActiveThemeColors(appearance);
  for (const role of WALLPAPER_ACCENT_ROLES) {
    document.documentElement.style.setProperty(getThemeColorVariable(role), colors[role]);
  }
}

/**
 * Paint the wallpaper onto the document:
 * - `html[data-wallpaper]` + `--app-wallpaper-*` drive the CSS translucency
 *   and media styling;
 * - when an accent is supplied, the accent family is regenerated from the
 *   theme's canvas + the extracted color (mirrors the guided theme editor).
 */
export function applyWallpaper(
  settings: WallpaperSettings,
  appearance: ThemeAppearance,
  accent: string | null,
): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (!root?.style) return;

  root.dataset.wallpaper = settings.kind;
  root.style.setProperty("--app-wallpaper-dim", String(settings.dim / 100));
  root.style.setProperty("--app-wallpaper-blur", `${settings.blur}px`);

  if (settings.extractAccent && accent) {
    const base = resolveActiveThemeColors(appearance);
    const regenerated = createManagedThemeColors(appearance, base.canvas, accent);
    for (const role of WALLPAPER_ACCENT_ROLES) {
      root.style.setProperty(getThemeColorVariable(role), regenerated[role]);
    }
  } else {
    // Toggling accent matching off (or a media with no dominant color) must
    // not leave the previous regeneration behind.
    restoreThemeAccentRoles(appearance);
  }
}

/** Remove every wallpaper marker and restore the theme's own accent family. */
export function clearWallpaper(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (!root?.style) return;

  delete root.dataset.wallpaper;
  root.style.removeProperty("--app-wallpaper-dim");
  root.style.removeProperty("--app-wallpaper-blur");
  const appearance: ThemeAppearance = root.classList.contains("dark") ? "dark" : "light";
  restoreThemeAccentRoles(appearance);
}

/* ------------------------------------------------------------------ */
/* Background-video playback rate (FPS)                                */
/* ------------------------------------------------------------------ */

const COMMON_REFRESH_RATES: ReadonlyArray<number> = [60, 90, 120, 144, 165, 240, 360];

let cachedMonitorRefreshRate: number | null = null;

/**
 * Estimate the monitor's refresh rate by sampling `requestAnimationFrame`
 * cadence for ~1.5s, rounded to a common rate (60/90/120/144/165/240/360).
 * Works in the browser and inside Electron's renderer. Resolves to 60 on any
 * failure or when the tab is throttled. The result is cached for the session.
 */
export function estimateMonitorRefreshRate(): Promise<number> {
  if (cachedMonitorRefreshRate !== null) {
    return Promise.resolve(cachedMonitorRefreshRate);
  }
  if (typeof window === "undefined" || typeof requestAnimationFrame !== "function") {
    cachedMonitorRefreshRate = 60;
    return Promise.resolve(60);
  }
  return new Promise((resolve) => {
    const samples: number[] = [];
    const started = performance.now();
    let last = started;
    const MAX_SAMPLE_MS = 1500;
    const onFrame = (now: number) => {
      const delta = now - last;
      last = now;
      // Ignore throttled frames (hidden tab, background) so the median stays true.
      if (delta > 5 && delta < 100) {
        samples.push(delta);
      }
      if (performance.now() - started < MAX_SAMPLE_MS) {
        requestAnimationFrame(onFrame);
      } else {
        let measured = 60;
        if (samples.length >= 10) {
          const sorted = [...samples].sort((a, b) => a - b);
          const median = sorted[Math.floor(sorted.length / 2)]!;
          measured = Math.round(1000 / Math.max(1, median));
        }
        cachedMonitorRefreshRate = COMMON_REFRESH_RATES.reduce(
          (best, rate) => (Math.abs(rate - measured) < Math.abs(best - measured) ? rate : best),
          60,
        );
        resolve(cachedMonitorRefreshRate);
      }
    };
    requestAnimationFrame(onFrame);
  });
}

/** Clamp a user-chosen fps into the valid stored range. */
export function clampWallpaperFps(fps: number, monitorRefreshRate: number): number {
  const monitorCap = Math.max(WALLPAPER_MIN_FPS, Math.round(monitorRefreshRate));
  return Math.min(WALLPAPER_MAX_FPS, Math.max(WALLPAPER_MIN_FPS, Math.round(fps)), monitorCap);
}

/* ------------------------------------------------------------------ */
/* Upload-time video normalization                                     */
/* ------------------------------------------------------------------ */

/** Videos at or below these caps are stored as-is (zero processing time). */
export const WALLPAPER_VIDEO_MAX_WIDTH = 1920;
export const WALLPAPER_VIDEO_MAX_FPS = 60;
export const WALLPAPER_VIDEO_FAST_PATH_BYTES = 20 * 1024 * 1024;

export interface WallpaperVideoMetadata {
  readonly width: number;
  readonly height: number;
  /** Measured playback frame rate (1-120); 0 when unknown. */
  readonly fps: number;
  readonly durationSec: number;
}

/**
 * Read a video blob's resolution, duration, and (measured) frame rate without
 * touching the wallpaper store. Plays the first ~1s of the blob off-screen.
 */
export function probeWallpaperVideoMetadata(blob: Blob): Promise<WallpaperVideoMetadata> {
  return new Promise((resolve, reject) => {
    if (typeof document === "undefined") {
      reject(new Error("No DOM available."));
      return;
    }
    const url = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    let settled = false;
    let deadline = 0;
    const finish = (meta: WallpaperVideoMetadata | null, error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(deadline);
      video.pause();
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      if (error || !meta) reject(error ?? new Error("Cannot read video metadata."));
      else resolve(meta);
    };
    // A corrupt or codec-unsupported blob must not hang the settings save.
    deadline = window.setTimeout(
      () => finish(null, new Error("Reading video metadata timed out.")),
      10_000,
    );
    video.onerror = () => finish(null, new Error("Cannot read video metadata."));
    video.onloadedmetadata = () => {
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!width || !height) {
        finish(null, new Error("Video has no frames."));
        return;
      }
      const durationSec = Number.isFinite(video.duration) ? video.duration : 0;
      let frames = 0;
      const started = performance.now();
      const sample = () => {
        frames += 1;
        const elapsed = performance.now() - started;
        if (elapsed < 1000 && frames < 150 && !video.ended) {
          video.requestVideoFrameCallback(sample);
        } else {
          const fps = Math.max(
            1,
            Math.min(120, Math.round((frames * 1000) / Math.max(1, elapsed))),
          );
          finish({ width, height, fps, durationSec });
        }
      };
      void video
        .play()
        .then(() => video.requestVideoFrameCallback(sample))
        .catch(() => {
          // Playback blocked (unusual for a muted local blob): assume 60fps.
          finish({ width, height, fps: 60, durationSec });
        });
    };
    video.src = url;
  });
}

/**
 * Best-effort normalization of a background-video blob:
 * - Already within caps (≤1920px wide, ≤60fps, ≤20MB) → returned unchanged.
 * - Otherwise re-encoded at the capped resolution/fps via a real-time
 *   canvas.captureStream + MediaRecorder pass (VP9/VP8 WebM), then verified
 *   playable before being returned.
 * - Any failure falls back to the original blob, so uploads never get worse.
 */
export async function normalizeWallpaperVideo(
  blob: Blob,
): Promise<{ readonly blob: Blob; readonly optimized: boolean }> {
  if (typeof MediaRecorder === "undefined" || typeof document === "undefined") {
    return { blob, optimized: false };
  }
  let meta: WallpaperVideoMetadata;
  try {
    meta = await probeWallpaperVideoMetadata(blob);
  } catch {
    return { blob, optimized: false };
  }
  const withinCaps =
    meta.width <= WALLPAPER_VIDEO_MAX_WIDTH &&
    meta.fps <= WALLPAPER_VIDEO_MAX_FPS &&
    blob.size <= WALLPAPER_VIDEO_FAST_PATH_BYTES;
  if (withinCaps) {
    return { blob, optimized: false };
  }
  try {
    const transcoded = await transcodeWallpaperVideo(blob, meta);
    if (transcoded.size >= blob.size) {
      return { blob, optimized: false };
    }
    return { blob: transcoded, optimized: true };
  } catch {
    return { blob, optimized: false };
  }
}

function transcodeWallpaperVideo(blob: Blob, meta: WallpaperVideoMetadata): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find(
      (candidate) => MediaRecorder.isTypeSupported(candidate),
    );
    if (!mimeType) {
      reject(new Error("No supported video encoder."));
      return;
    }
    const targetWidth = Math.min(meta.width, WALLPAPER_VIDEO_MAX_WIDTH);
    const targetHeight = Math.max(
      1,
      Math.round((targetWidth * meta.height) / Math.max(1, meta.width)),
    );
    const targetFps = Math.min(
      WALLPAPER_VIDEO_MAX_FPS,
      Math.max(WALLPAPER_MIN_FPS, meta.fps || 30),
    );
    const bitrate = targetWidth <= 1280 ? 4_000_000 : targetWidth <= 1920 ? 6_000_000 : 8_000_000;

    const url = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = url;
    video.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;";
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      URL.revokeObjectURL(url);
      reject(new Error("Canvas unavailable."));
      return;
    }

    let recorder: MediaRecorder | null = null;
    let drawTimer = 0;
    let settled = false;
    let deadline = 0;
    const cleanup = () => {
      window.clearInterval(drawTimer);
      window.clearTimeout(deadline);
      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          /* noop */
        }
      }
      video.pause();
      video.removeAttribute("src");
      video.load();
      video.remove();
      URL.revokeObjectURL(url);
    };
    // Master deadline: a corrupt blob (no loadedmetadata/ended) must fall back
    // to the original instead of hanging the settings save. Real-time
    // transcodes need source-duration wall time plus a generous margin.
    deadline = window.setTimeout(
      () => finish(null, new Error("Video optimization timed out.")),
      Math.max(30_000, meta.durationSec * 1000 + 30_000),
    );
    const finish = (out: Blob | null, error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error || !out) reject(error ?? new Error("Video optimization failed."));
      else resolve(out);
    };

    video.onerror = () => finish(null, new Error("Cannot read video for optimization."));
    video.onended = () => {
      // Capture the final frame, then stop the recorder.
      window.clearInterval(drawTimer);
      ctx.drawImage(video, 0, 0, targetWidth, targetHeight);
      if (recorder && recorder.state !== "inactive") recorder.stop();
    };
    video.onloadedmetadata = () => {
      const stream = canvas.captureStream(targetFps);
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        const output = new Blob(chunks, { type: mimeType });
        // Only commit to the transcoded blob if it actually plays.
        verifyPlayableVideo(output)
          .then(() => finish(output))
          .catch(() => finish(null, new Error("Optimized video failed verification.")));
      };
      recorder.onerror = () => finish(null, new Error("Recording failed."));
      recorder.start(500);
      drawTimer = window.setInterval(
        () => {
          if (
            !video.paused &&
            !video.ended &&
            video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
          ) {
            ctx.drawImage(video, 0, 0, targetWidth, targetHeight);
          }
        },
        Math.max(16, Math.round(1000 / Math.max(1, targetFps))),
      );
      void video
        .play()
        .catch(() => finish(null, new Error("Playback failed during optimization.")));
    };
    document.body.append(video);
  });
}

function verifyPlayableVideo(blob: Blob): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    let settled = false;
    let deadline = 0;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(deadline);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      if (error) reject(error);
      else resolve();
    };
    // Never hang the upload on an unreadable transcoded blob.
    deadline = window.setTimeout(() => finish(new Error("Verification timed out.")), 10_000);
    video.onloadedmetadata = () => finish();
    video.onerror = () => finish(new Error("Verification failed."));
    video.src = url;
  });
}
