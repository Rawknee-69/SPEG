import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useTheme } from "../hooks/useTheme";
import { isElectron } from "../env";
import {
  applyWallpaper,
  clearWallpaper,
  estimateMonitorRefreshRate,
  extractWallpaperAccent,
  getWallpaperMedia,
  readWallpaper,
  subscribeWallpaper,
  WALLPAPER_DEFAULTS,
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
  const [monitorHz, setMonitorHz] = useState(60);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // The slider lets users cap the background-video playback rate at or below
  // the monitor's refresh rate. Below the monitor rate we sample the video
  // into a resolution-capped canvas at the chosen FPS; at (or above) the
  // monitor rate we let the video element play natively with no extra pass.
  const wallpaperFps = wallpaper?.fps ?? WALLPAPER_DEFAULTS.fps;
  const useCanvas = wallpaper?.kind === "video" && wallpaperFps < monitorHz;

  useEffect(() => {
    let alive = true;
    void estimateMonitorRefreshRate().then((hz) => {
      if (alive) setMonitorHz(hz);
    });
    return () => {
      alive = false;
    };
  }, []);

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

  // Keep background video cheap: play only while visible, motion allowed, and
  // (in the desktop shell, which keeps running while occluded) the window is
  // focused — an occluded/minimized desktop window must not burn GPU decoding.
  const syncVideoPlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const visible = document.visibilityState === "visible" && !prefersReducedMotion();
    const focused = !isElectron || document.hasFocus();
    if (visible && focused) {
      void video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, []);

  useEffect(() => {
    if (wallpaper?.kind !== "video" || !mediaUrl) return;
    syncVideoPlayback();
    document.addEventListener("visibilitychange", syncVideoPlayback);
    if (isElectron) {
      window.addEventListener("blur", syncVideoPlayback);
      window.addEventListener("focus", syncVideoPlayback);
    }
    return () => {
      document.removeEventListener("visibilitychange", syncVideoPlayback);
      if (isElectron) {
        window.removeEventListener("blur", syncVideoPlayback);
        window.removeEventListener("focus", syncVideoPlayback);
      }
      videoRef.current?.pause();
    };
  }, [wallpaper?.kind, mediaUrl, syncVideoPlayback]);

  // FPS-limited wallpaper rendering: when the chosen fps is below the monitor
  // refresh rate, sample the video into a resolution-capped canvas at most
  // once per 1000/fps ms instead of compositing every native video frame.
  useEffect(() => {
    if (!useCanvas || wallpaper?.kind !== "video" || !mediaUrl) return;
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const fps = wallpaperFps;
    const intervalMs = 1000 / Math.max(1, fps);
    const MAX_CANVAS_WIDTH = 1920;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const viewportWidth = Math.max(1, window.innerWidth);
      const viewportHeight = Math.max(1, window.innerHeight);
      const canvasWidth = Math.min(viewportWidth, MAX_CANVAS_WIDTH);
      const canvasHeight = Math.round((canvasWidth * viewportHeight) / viewportWidth);
      canvas.width = Math.max(1, Math.round(canvasWidth * dpr));
      canvas.height = Math.max(1, Math.round(canvasHeight * dpr));
    };
    resize();
    window.addEventListener("resize", resize);

    let raf = 0;
    let lastDraw = 0;
    let lastVideoTime = -1;
    const tick = (now: number) => {
      if (now - lastDraw >= intervalMs) {
        if (
          video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
          video.currentTime !== lastVideoTime
        ) {
          const cw = canvas.width;
          const ch = canvas.height;
          const vw = video.videoWidth || cw;
          const vh = video.videoHeight || ch;
          // Cover-fit draw (same geometry as the CSS object-fit: cover rule).
          const scale = Math.max(cw / vw, ch / vh);
          const dw = vw * scale;
          const dh = vh * scale;
          ctx.drawImage(video, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
          lastVideoTime = video.currentTime;
        }
        lastDraw = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [useCanvas, wallpaper?.kind, wallpaperFps, mediaUrl]);

  if (!wallpaper || !mediaUrl) return null;

  return (
    <div id="wallpaper-layer" aria-hidden="true" data-ready={isReady || undefined}>
      {wallpaper.kind === "video" ? (
        <>
          {/* The video element stays at the same tree position whether or not
              the FPS-limited canvas is active, so resolving the monitor rate
              mid-session never remounts/restarts playback. In canvas mode it
              is visually hidden but keeps decoding for the sampler. */}
          <video
            ref={videoRef}
            className={useCanvas ? "wallpaper-video-hidden" : undefined}
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
          {useCanvas ? (
            <canvas ref={canvasRef} className="wallpaper-canvas" aria-hidden="true" />
          ) : null}
        </>
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
