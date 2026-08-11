import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useTheme } from "../hooks/useTheme";
import {
  applyWallpaper,
  clearWallpaper,
  extractWallpaperAccent,
  getWallpaperMedia,
  readWallpaper,
  subscribeWallpaper,
  type WallpaperSettings,
} from "../wallpaper";

export function useWallpaper(): WallpaperSettings | null {
  return useSyncExternalStore(subscribeWallpaper, readWallpaper, readWallpaper);
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Fixed full-screen media layer behind the app. It owns the media element
 * lifecycle (IndexedDB -> object URL), pauses background video when the tab
 * is hidden or the user prefers reduced motion, and re-applies the CSS
 * overrides whenever the wallpaper, the resolved theme, or the extracted
 * accent changes.
 */
export function WallpaperLayer() {
  const wallpaper = useWallpaper();
  const { resolvedTheme } = useTheme();
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [accent, setAccent] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Reset the fade-in when the media identity changes.
  useEffect(() => {
    setIsReady(false);
  }, [wallpaper?.id, mediaUrl]);

  // Load the media blob and expose it as an object URL (revoked on change).
  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    if (!wallpaper) {
      setMediaUrl(null);
      return () => {
        cancelled = true;
      };
    }
    void getWallpaperMedia(wallpaper.id).then((blob) => {
      if (cancelled || !blob) return;
      objectUrl = URL.createObjectURL(blob);
      setMediaUrl(objectUrl);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [wallpaper?.id]);

  // Apply (or clear) the document-level overrides.
  useEffect(() => {
    if (!wallpaper || !mediaUrl) {
      clearWallpaper();
      return;
    }
    applyWallpaper(wallpaper, resolvedTheme, accent);
  }, [wallpaper, mediaUrl, resolvedTheme, accent]);

  // Extract the accent from the media once its first frame is available.
  // Videos reuse the visible layer element (no second download); the first
  // frame arrives via onLoadedData below, and this effect covers the case
  // where "match accent" is toggled on after the video already loaded.
  const extractVideoAccent = useCallback(() => {
    const video = videoRef.current;
    if (video && video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      setAccent(extractWallpaperAccent(video));
    }
  }, []);

  useEffect(() => {
    if (!wallpaper?.extractAccent || !mediaUrl) {
      setAccent(null);
      return;
    }
    if (wallpaper.kind === "video") {
      extractVideoAccent();
      return;
    }
    let cancelled = false;
    const image = new Image();
    image.decoding = "async";
    const onLoad = () => {
      if (!cancelled) setAccent(extractWallpaperAccent(image));
      image.removeEventListener("load", onLoad);
    };
    image.addEventListener("load", onLoad);
    image.src = mediaUrl;
    return () => {
      cancelled = true;
      image.removeEventListener("load", onLoad);
    };
  }, [wallpaper?.extractAccent, wallpaper?.kind, mediaUrl, extractVideoAccent]);

  // Keep background video cheap: play only while visible and motion allowed.
  const syncVideoPlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (document.visibilityState === "visible" && !prefersReducedMotion()) {
      void video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, []);

  useEffect(() => {
    if (wallpaper?.kind !== "video" || !mediaUrl) return;
    syncVideoPlayback();
    document.addEventListener("visibilitychange", syncVideoPlayback);
    return () => {
      document.removeEventListener("visibilitychange", syncVideoPlayback);
      videoRef.current?.pause();
    };
  }, [wallpaper?.kind, mediaUrl, syncVideoPlayback]);

  if (!wallpaper || !mediaUrl) return null;

  return (
    <div id="wallpaper-layer" aria-hidden="true" data-ready={isReady || undefined}>
      {wallpaper.kind === "video" ? (
        <video
          ref={videoRef}
          src={mediaUrl}
          muted
          loop
          playsInline
          autoPlay
          disablePictureInPicture
          onLoadedData={() => {
            setIsReady(true);
            syncVideoPlayback();
            extractVideoAccent();
          }}
        />
      ) : (
        <img
          src={mediaUrl}
          alt=""
          decoding="async"
          draggable={false}
          onLoad={() => setIsReady(true)}
        />
      )}
      <div className="wallpaper-dim" />
    </div>
  );
}
