import { useEffect, useRef, useState, type CSSProperties } from "react";
import { FilmIcon, ImageIcon, Trash2Icon, UploadIcon } from "lucide-react";

import {
  deleteWallpaperMedia,
  getWallpaperMedia,
  putWallpaperMedia,
  readWallpaper,
  WALLPAPER_DEFAULTS,
  WALLPAPER_MAX_BLUR,
  WALLPAPER_MAX_DIM,
  WALLPAPER_MAX_GIF_BYTES,
  WALLPAPER_MAX_VIDEO_BYTES,
  WALLPAPER_MIN_BLUR,
  WALLPAPER_MIN_DIM,
  writeWallpaper,
  type WallpaperKind,
  type WallpaperSettings,
} from "../../wallpaper";
import { useWallpaper } from "../WallpaperLayer";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { stackedThreadToast } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const WALLPAPER_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm";

function wallpaperKindFor(file: File): WallpaperKind | null {
  if (file.type === "image/gif") return "gif";
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  return null;
}

function sliderStyle(value: number, min: number, max: number): CSSProperties {
  const ratio = (value - min) / (max - min);
  return {
    "--settings-slider-progress": `${ratio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
  } as CSSProperties;
}

/** Downscale oversized still images so the stored blob stays small and light. */
async function compressWallpaperImage(file: File): Promise<Blob> {
  const MAX_EDGE = 2560;
  const source =
    typeof createImageBitmap === "function"
      ? await createImageBitmap(file).catch(() => null)
      : null;
  if (!source) return file;
  const scale = Math.min(1, MAX_EDGE / Math.max(source.width, source.height));
  if (scale >= 1 && file.size < 2 * 1024 * 1024) {
    source.close();
    return file;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const context = canvas.getContext("2d");
  if (!context) {
    source.close();
    return file;
  }
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/webp", 0.85),
  );
  return blob ?? file;
}

function WallpaperPreview({ wallpaper }: { wallpaper: WallpaperSettings }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    void getWallpaperMedia(wallpaper.id).then((blob) => {
      if (cancelled || !blob) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [wallpaper.id]);

  return (
    <div className="flex h-28 w-full items-center justify-center overflow-hidden rounded-lg border border-border bg-muted/40">
      {url ? (
        wallpaper.kind === "video" ? (
          <video
            className="h-full w-full object-cover"
            src={url}
            muted
            playsInline
            preload="metadata"
          />
        ) : (
          <img className="h-full w-full object-cover" src={url} alt="Current wallpaper" />
        )
      ) : (
        <span className="text-xs text-muted-foreground">Loading preview…</span>
      )}
    </div>
  );
}

/**
 * "Background" section of Appearance settings: pick an image, GIF, or video
 * as the app-wide wallpaper, tune dim/blur, and optionally match the theme
 * accent to the media.
 */
export function WallpaperSettings() {
  const wallpaper = useWallpaper();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isReading, setIsReading] = useState(false);

  const applyPatch = (patch: Partial<WallpaperSettings>) => {
    if (!wallpaper) return;
    writeWallpaper({ ...wallpaper, ...patch });
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    const kind = wallpaperKindFor(file);
    if (!kind) {
      stackedThreadToast({
        type: "error",
        title: "Unsupported file",
        description: "Choose a PNG, JPEG, WebP, GIF, or MP4/WebM video.",
      });
      return;
    }
    const sizeLimit =
      kind === "video"
        ? WALLPAPER_MAX_VIDEO_BYTES
        : kind === "gif"
          ? WALLPAPER_MAX_GIF_BYTES
          : 6 * 1024 * 1024;
    if (kind !== "image" && file.size > sizeLimit) {
      stackedThreadToast({
        type: "error",
        title: "File too large",
        description: kind === "video" ? "Videos must be under 80 MB." : "GIFs must be under 40 MB.",
      });
      return;
    }
    setIsReading(true);
    try {
      // Still images are compressed first, then size-checked against the
      // result so a big-but-compressible photo is not rejected up front.
      const blob = kind === "image" ? await compressWallpaperImage(file) : file;
      if (blob.size > sizeLimit) {
        stackedThreadToast({
          type: "error",
          title: "File too large",
          description: "Images must be under 6 MB after compression.",
        });
        return;
      }
      // A wall/paper id is a storage key, not a security boundary: a timestamp
      // + random suffix is enough to avoid collisions between uploads.
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      await putWallpaperMedia(id, blob);
      const previous = readWallpaper();
      if (previous) await deleteWallpaperMedia(previous.id).catch(() => {});
      writeWallpaper({ ...WALLPAPER_DEFAULTS, id, kind });
    } catch {
      stackedThreadToast({
        type: "error",
        title: "Could not save wallpaper",
        description: "The media store is unavailable; try a smaller file.",
      });
    } finally {
      setIsReading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleRemove = async () => {
    const previous = readWallpaper();
    writeWallpaper(null);
    if (previous) await deleteWallpaperMedia(previous.id).catch(() => {});
  };

  return (
    <SettingsSection id="background" title="Background">
      <SettingsRow
        {...searchableSetting("wallpaper")}
        description="Set an image, GIF, or video as the app-wide background. The theme surfaces turn translucent so it shows through — pause or reduce motion stops video playback automatically."
        control={
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              accept={WALLPAPER_ACCEPT}
              className="sr-only"
              onChange={(event) => void handleFile(event.currentTarget.files?.[0])}
              type="file"
            />
            <Button
              disabled={isReading}
              size="sm"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
            >
              <UploadIcon />
              {isReading ? "Saving…" : wallpaper ? "Replace" : "Choose"}
            </Button>
            {wallpaper ? (
              <Button
                size="sm"
                variant="ghost"
                aria-label="Remove background"
                onClick={() => void handleRemove()}
              >
                <Trash2Icon />
              </Button>
            ) : null}
          </div>
        }
      >
        {wallpaper ? (
          <div className="space-y-3">
            <WallpaperPreview wallpaper={wallpaper} />
            <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
              {wallpaper.kind === "video" ? (
                <FilmIcon className="size-3.5" />
              ) : (
                <ImageIcon className="size-3.5" />
              )}
              {wallpaper.kind === "video"
                ? "Video"
                : wallpaper.kind === "gif"
                  ? "Animated GIF"
                  : "Image"}{" "}
              background
            </div>
          </div>
        ) : null}
      </SettingsRow>
      {wallpaper ? (
        <>
          <SettingsRow
            {...searchableSetting("wallpaper-dim")}
            title="Dim"
            description="Darken the media so text stays readable. Higher values are calmer and cheaper on the eye."
            control={
              <div className="flex w-full items-center gap-3 sm:w-52">
                <output className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground">
                  {wallpaper.dim}%
                </output>
                <input
                  aria-label="Wallpaper dim"
                  className="settings-slider min-w-0 flex-1"
                  max={WALLPAPER_MAX_DIM}
                  min={WALLPAPER_MIN_DIM}
                  onChange={(event) => applyPatch({ dim: Number(event.currentTarget.value) })}
                  style={sliderStyle(wallpaper.dim, WALLPAPER_MIN_DIM, WALLPAPER_MAX_DIM)}
                  type="range"
                  value={wallpaper.dim}
                />
              </div>
            }
          />
          <SettingsRow
            {...searchableSetting("wallpaper-blur")}
            title="Blur"
            description="Soften the background for a frosted-glass look. Blur costs one full-screen GPU pass, so keep it low on weaker machines."
            control={
              <div className="flex w-full items-center gap-3 sm:w-52">
                <output className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground">
                  {wallpaper.blur}px
                </output>
                <input
                  aria-label="Wallpaper blur"
                  className="settings-slider min-w-0 flex-1"
                  max={WALLPAPER_MAX_BLUR}
                  min={WALLPAPER_MIN_BLUR}
                  onChange={(event) => applyPatch({ blur: Number(event.currentTarget.value) })}
                  style={sliderStyle(wallpaper.blur, WALLPAPER_MIN_BLUR, WALLPAPER_MAX_BLUR)}
                  type="range"
                  value={wallpaper.blur}
                />
              </div>
            }
          />
          <SettingsRow
            {...searchableSetting("wallpaper-accent")}
            title="Match accent to background"
            description="Extract the dominant color from the media and re-tint the whole app's accent family with it."
            control={
              <Switch
                checked={wallpaper.extractAccent}
                onCheckedChange={(checked) => applyPatch({ extractAccent: checked })}
                aria-label="Match accent to background"
              />
            }
          />
        </>
      ) : null}
    </SettingsSection>
  );
}
