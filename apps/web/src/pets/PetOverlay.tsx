import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { AGENT_STATE_TO_VISUAL, renderSize, SpriteRenderer } from "@speg/pets";
import type { PetManifest, PetVisualState } from "@speg/pets";
import { ThreadId, type DesktopBridge, type PetSettings } from "@speg/contracts";

import { Button } from "~/components/ui/button";
import { useUpdateClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { buildThreadRouteParams } from "~/threadRoutes";
import {
  DEFAULT_PET_ASSET_URL,
  DEFAULT_PET_ID,
  DEFAULT_PET_MANIFEST,
  listInstalledPets,
  type InstalledPet,
} from "./petAssets";
import { usePetSnapshot } from "./usePetSnapshot";

const NOW_TICK_MS = 30_000;
const BUBBLE_AUTO_HIDE_MS = 4_000;
const DRAG_THRESHOLD_PX = 4;

interface SelectedPet {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly manifest: PetManifest;
  /** null for the built-in pet; a validated blob for imported custom pets. */
  readonly spritesheet: Blob | null;
  readonly builtIn: boolean;
}

function anchorStyle(
  anchor: PetSettings["anchor"],
  offsetX: number,
  offsetY: number,
  dragPosition: { readonly x: number; readonly y: number } | null,
): CSSProperties {
  if (dragPosition !== null) {
    return { position: "fixed", left: dragPosition.x, top: dragPosition.y, zIndex: 50 };
  }
  const style: CSSProperties = { position: "fixed", zIndex: 50 };
  if (anchor.includes("left")) style.left = offsetX;
  if (anchor.includes("right")) style.right = offsetX;
  if (anchor.includes("top")) style.top = offsetY;
  if (anchor.includes("bottom")) style.bottom = offsetY;
  if (anchor === "center") style.left = `calc(50% - ${offsetX}px)`;
  if (anchor === "center-left") style.top = `calc(50% - ${offsetY}px)`;
  if (anchor === "center-right") style.top = `calc(50% - ${offsetY}px)`;
  if (anchor === "top-center") style.left = `calc(50% - ${offsetX}px)`;
  if (anchor === "bottom-center") style.left = `calc(50% - ${offsetX}px)`;
  return style;
}

function anchorPixelOrigin(
  anchor: PetSettings["anchor"],
  width: number,
  height: number,
): { readonly x: number; readonly y: number } {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const left = anchor.includes("left")
    ? 0
    : anchor.includes("right")
      ? viewportWidth - width
      : (viewportWidth - width) / 2;
  const top = anchor.includes("top")
    ? 0
    : anchor.includes("bottom")
      ? viewportHeight - height
      : (viewportHeight - height) / 2;
  return { x: left, y: top };
}

export function formatPetStateLabel(state: PetVisualState): string {
  switch (state) {
    case "idle":
      return "idle";
    case "running":
      return "working";
    case "running-right":
      return "moving right";
    case "running-left":
      return "moving left";
    case "waiting":
      return "waiting for you";
    case "review":
      return "ready for review";
    case "failed":
      return "task failed";
    case "waving":
      return "waving";
    case "jumping":
      return "celebrating";
    default:
      return state;
  }
}

/**
 * The pet widget (spec §1, §12). Renders the followed agent's state via the
 * sprite atlas on a canvas, with a status bubble, drag-to-reposition, click
 * popover, and context menu.
 *
 * Two surfaces share this component:
 * - web / remote: a fixed-position in-app widget.
 * - desktop overlay (`overlay`): the Electron transparent window's pet-only
 *   surface — dragging moves the window via IPC, the window handles
 *   click-through/always-on-top, and the in-app widget renders nothing.
 *
 * Keeps a single decoded atlas in memory and stops its animation loop when
 * hidden or in reduced-motion mode (spec §82, §43).
 */
export function PetOverlay({ overlay = false }: { readonly overlay?: boolean }) {
  const isElectronHost = typeof window !== "undefined" && "desktopBridge" in window;

  // In the desktop app the transparent overlay window is the pet surface; the
  // in-app widget renders nothing (spec §12 "useful even when the main agent
  // UI is hidden").
  if (isElectronHost && !overlay) {
    return null;
  }
  if (!overlay) {
    return <PetOverlayRouterAware />;
  }
  // The overlay surface has no router; navigation targets live in the main
  // window, so the overlay's popover/menu drop router-backed actions.
  return <PetOverlayInner overlay navigate={null} />;
}

function PetOverlayRouterAware() {
  return <PetOverlayInner overlay={false} navigate={useNavigate()} />;
}

function PetOverlayInner({
  overlay,
  navigate,
}: {
  readonly overlay: boolean;
  readonly navigate: ReturnType<typeof useNavigate> | null;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const updateClientSettings = useUpdateClientSettings();
  const [now, setNow] = useState(() => Date.now());
  const { settings, selection, bubble } = usePetSnapshot(now);

  // Clock tick so review-window decay and celebration cooldowns advance even
  // without thread updates.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const enabled = settings.enabled && settings.visible;
  const context = selection.context;

  const desktopBridge =
    typeof window !== "undefined"
      ? (window as Window & { desktopBridge?: DesktopBridge }).desktopBridge
      : undefined;

  // Overlay window: show/hide the window and mirror window-level settings.
  useEffect(() => {
    if (!overlay || desktopBridge === undefined) return;
    if (enabled) {
      void desktopBridge.petEnsure?.();
    } else {
      void desktopBridge.petHide?.();
    }
  }, [desktopBridge, enabled, overlay]);

  useEffect(() => {
    if (!overlay || desktopBridge === undefined) return;
    void desktopBridge.petSetSettings?.({
      alwaysOnTop: settings.alwaysOnTop,
      clickThrough: settings.clickThrough,
      hideOnFullscreen: settings.hideOnFullscreen,
    });
  }, [
    desktopBridge,
    overlay,
    settings.alwaysOnTop,
    settings.clickThrough,
    settings.hideOnFullscreen,
  ]);

  const [installedPets, setInstalledPets] = useState<ReadonlyArray<InstalledPet>>([]);
  useEffect(() => {
    let cancelled = false;
    void listInstalledPets().then((pets) => {
      if (!cancelled) setInstalledPets(pets);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedPet: SelectedPet | null = useMemo(() => {
    if (settings.selectedPet === DEFAULT_PET_ID) {
      return {
        id: DEFAULT_PET_MANIFEST.id,
        displayName: DEFAULT_PET_MANIFEST.displayName,
        description: DEFAULT_PET_MANIFEST.description,
        manifest: DEFAULT_PET_MANIFEST,
        spritesheet: null,
        builtIn: true,
      };
    }
    const installed = installedPets.find((pet) => pet.id === settings.selectedPet);
    return installed === undefined
      ? null
      : {
          id: installed.id,
          displayName: installed.displayName,
          description: installed.description,
          manifest: installed.manifest,
          spritesheet: installed.spritesheet,
          builtIn: false,
        };
  }, [installedPets, settings.selectedPet]);

  // Load the selected pet's atlas once into an ImageBitmap.
  const [atlas, setAtlas] = useState<ImageBitmap | null>(null);
  const [atlasError, setAtlasError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setAtlas(null);
    setAtlasError(false);
    const source =
      selectedPet?.spritesheet !== null && selectedPet?.spritesheet !== undefined
        ? URL.createObjectURL(selectedPet.spritesheet)
        : DEFAULT_PET_ASSET_URL;
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      void createImageBitmap(image).then(
        (bitmap) => {
          if (!cancelled) setAtlas(bitmap);
        },
        () => {
          if (!cancelled) setAtlasError(true);
        },
      );
    };
    image.onerror = () => {
      if (!cancelled) setAtlasError(true);
    };
    image.src = source;
    return () => {
      cancelled = true;
      if (source.startsWith("blob:")) URL.revokeObjectURL(source);
    };
    // selectedPet.id and the blob identity capture what the atlas depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPet?.builtIn, selectedPet?.id, selectedPet?.spritesheet]);

  // Close a superseded atlas so switching pets never leaks decoded bitmaps.
  useEffect(() => {
    return () => {
      setAtlas((current) => {
        if (current !== null) {
          current.close();
        }
        return null;
      });
    };
  }, []);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<SpriteRenderer | null>(null);
  if (rendererRef.current === null) {
    rendererRef.current = new SpriteRenderer();
  }
  const renderer = rendererRef.current;

  const { width, height } = useMemo(() => renderSize(settings.scale), [settings.scale]);
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;

  const draw = useCallback(
    (state: PetVisualState, frame: number) => {
      const canvas = canvasRef.current;
      if (canvas === null || atlas === null) return;
      const context2d = canvas.getContext("2d");
      if (context2d === null) return;
      context2d.clearRect(0, 0, canvas.width, canvas.height);
      renderer.render(context2d, { image: atlas, width, height, override: { state, frame } });
    },
    [atlas, height, renderer, width],
  );

  // Animation loop: only while visible and an atlas is loaded.
  useEffect(() => {
    if (!enabled || atlas === null) return;
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const context2d = canvas.getContext("2d");
    if (context2d === null) return;
    context2d.clearRect(0, 0, canvas.width, canvas.height);

    const pickFrame = (frame: number): PetVisualState =>
      dragOverrideRef.current ?? renderer.controller.state;

    if (settings.reducedMotion) {
      const state = AGENT_STATE_TO_VISUAL[context?.agentState ?? "idle"];
      draw(pickFrame(0), 0);
      return;
    }

    let raf = 0;
    let last = performance.now();
    const loop = (time: number) => {
      const delta = Math.min(time - last, 100);
      last = time;
      renderer.update(delta);
      const snapshot = renderer.controller.snapshot();
      draw(pickFrame(snapshot.frame), snapshot.frame);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [atlas, context?.agentState, draw, enabled, renderer, settings.reducedMotion]);

  // Drive the desired state from the resolved context, celebrating completed work.
  const previousAgentState = useRef<string | null>(null);
  useEffect(() => {
    if (context === null) {
      renderer.reset("idle");
      previousAgentState.current = null;
      return;
    }
    const visual = AGENT_STATE_TO_VISUAL[context.agentState];
    const celebrate = context.agentState === "review" && previousAgentState.current === "running";
    renderer.setDesiredState(visual, { celebrate, now });
    previousAgentState.current = context.agentState;
  }, [context, now, renderer]);

  // Status bubble: auto-hides unless the state blocks attention.
  const [bubbleVisible, setBubbleVisible] = useState(false);
  useEffect(() => {
    if (bubble === null) {
      setBubbleVisible(false);
      return;
    }
    setBubbleVisible(true);
    if (!context?.requiresAttention) {
      const timer = setTimeout(() => setBubbleVisible(false), BUBBLE_AUTO_HIDE_MS);
      return () => clearTimeout(timer);
    }
  }, [bubble, context?.requiresAttention]);

  // ── Interaction ───────────────────────────────────────────────────

  const [dragPosition, setDragPosition] = useState<{ x: number; y: number } | null>(null);
  const dragOverrideRef = useRef<PetVisualState | null>(null);
  const [dragDirection, setDragDirection] = useState<PetVisualState>("running-right");
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; moved: boolean } | null>(null);

  const persistPosition = useCallback(
    (x: number, y: number) => {
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const anchor = settings.anchor;
      const offsetX = anchor.includes("right") ? viewportWidth - x - width : x;
      const offsetY = anchor.includes("bottom") ? viewportHeight - y - height : y;
      updateClientSettings({
        pets: { ...settings, offsetX: Math.round(offsetX), offsetY: Math.round(offsetY) },
      });
    },
    [height, settings, updateClientSettings, width],
  );

  const handlePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startY: event.clientY, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (drag === null) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
      const direction: PetVisualState = dx >= 0 ? "running-right" : "running-left";
      dragOverrideRef.current = direction;
      setDragDirection(direction);
      setPopoverOpen(false);
      if (overlay) {
        // The overlay window itself moves; keep the last delta so a release
        // without further moves still lands.
        dragRef.current = { ...drag, startX: event.clientX, startY: event.clientY };
        void desktopBridge?.petDrag?.({ dx, dy });
        return;
      }
      const base = anchorPixelOrigin(settings.anchor, width, height);
      setDragPosition({ x: base.x + dx, y: base.y + dy });
    },
    [desktopBridge, height, overlay, settings.anchor, width],
  );

  const handlePointerUp = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      dragRef.current = null;
      dragOverrideRef.current = null;
      if (drag === null) return;
      if (drag.moved) {
        if (overlay) {
          setDragPosition(null);
          return;
        }
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        const base = anchorPixelOrigin(settings.anchor, width, height);
        persistPosition(base.x + dx, base.y + dy);
        setDragPosition(null);
        return;
      }
      // Plain click.
      setMenuOpen(false);
      setPopoverOpen((open) => !open);
    },
    [height, overlay, persistPosition, settings.anchor, width],
  );

  const openFollowedThread = useCallback(() => {
    if (navigate === null || environmentId === null || selection.threadId === null) return;
    setPopoverOpen(false);
    setMenuOpen(false);
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams({
        environmentId,
        threadId: ThreadId.make(selection.threadId),
      }),
    });
  }, [environmentId, navigate, selection.threadId]);

  const hidePet = useCallback(() => {
    setMenuOpen(false);
    setPopoverOpen(false);
    updateClientSettings({ pets: { ...settings, visible: false } });
    if (overlay) {
      void desktopBridge?.petHide?.();
    }
  }, [desktopBridge, overlay, settings, updateClientSettings]);

  const openSettings = useCallback(() => {
    if (navigate === null) return;
    setMenuOpen(false);
    setPopoverOpen(false);
    void navigate({ to: "/settings/pets" });
  }, [navigate]);

  if (!enabled) {
    return null;
  }

  const visualState = AGENT_STATE_TO_VISUAL[context?.agentState ?? "idle"];
  const ariaLabel =
    context === null
      ? "Pet companion, idle"
      : `Pet companion, ${formatPetStateLabel(visualState)}${bubble !== null ? ` — ${bubble}` : ""}`;

  return (
    <div
      className="fixed z-50 select-none"
      style={anchorStyle(settings.anchor, settings.offsetX, settings.offsetY, dragPosition)}
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setPopoverOpen((open) => !open);
        }
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onContextMenu={(event) => {
        event.preventDefault();
        setPopoverOpen(false);
        setMenuOpen((open) => !open);
      }}
    >
      {bubbleVisible && bubble !== null ? (
        <div
          role="status"
          aria-live="polite"
          className={cn(
            "glass-surface glass-thick absolute bottom-full left-1/2 z-10 mb-2 -translate-x-1/2 rounded-lg px-2.5 py-1 text-xs font-medium whitespace-nowrap text-foreground",
            context?.requiresAttention ? "text-warning" : "",
          )}
        >
          {bubble}
        </div>
      ) : null}
      <canvas
        ref={canvasRef}
        width={Math.round(width * dpr)}
        height={Math.round(height * dpr)}
        style={{ width, height, imageRendering: "pixelated", cursor: "grab", display: "block" }}
        aria-hidden
      />
      {atlasError ? (
        <div className="glass-surface glass-thick absolute top-full left-1/2 mt-1 -translate-x-1/2 rounded-md px-2 py-0.5 text-[10px] text-destructive">
          Pet atlas unavailable
        </div>
      ) : null}

      {popoverOpen && context !== null ? (
        <div className="glass-surface glass-thick absolute bottom-full left-1/2 z-20 mb-2 w-56 -translate-x-1/2 rounded-xl p-3 text-foreground">
          <p className="truncate text-sm font-semibold">{context.title}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {formatPetStateLabel(visualState)}
            {context.progress !== null
              ? ` · ${context.progress.completedSteps}/${context.progress.totalSteps}`
              : ""}
          </p>
          {selection.workspace.total > 1 ? (
            <p className="mt-1 text-[11px] text-muted-foreground/70">
              {selection.workspace.total} agents in this environment
            </p>
          ) : null}
          <div className="mt-2 flex flex-col gap-1">
            {navigate !== null ? (
              <Button size="xs" onClick={openFollowedThread}>
                Open task
              </Button>
            ) : null}
            {navigate !== null ? (
              <Button size="xs" variant="ghost" onClick={openSettings}>
                Pet settings
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {menuOpen ? (
        <div className="glass-surface glass-floating absolute bottom-full left-1/2 z-20 mb-2 w-44 -translate-x-1/2 rounded-xl p-1 text-foreground">
          {navigate !== null ? (
            <MenuButton onClick={openFollowedThread} disabled={selection.threadId === null}>
              Open task
            </MenuButton>
          ) : null}
          <MenuButton onClick={hidePet}>Hide pet</MenuButton>
          {navigate !== null ? <MenuButton onClick={openSettings}>Pet settings</MenuButton> : null}
        </div>
      ) : null}
    </div>
  );
}

function MenuButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="w-full rounded-lg px-2.5 py-1.5 text-left text-[13px] font-medium text-foreground hover:bg-sidebar-row-hover disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}
