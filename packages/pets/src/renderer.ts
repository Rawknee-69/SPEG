import {
  DEFAULT_ANIMATIONS,
  frameSourceRect,
  type AnimationDefinition,
  type PetVisualState,
} from "./atlas.ts";
import { AnimationController, type AnimationControllerOptions } from "./animation.ts";

/**
 * Canvas sprite renderer (spec §32, §125-126). Pure playback state lives in
 * `AnimationController`; this class only knows how to blit a frame from the
 * atlas into a 2D canvas context.
 *
 * Pixel-art pets render nearest-neighbor by default; non-pixel styles can opt
 * into smoothing. Baseline/registration alignment is the caller's job (the
 * widget positions the canvas); `frameSourceRect` provides the source rect.
 */
export interface SpriteRendererOptions {
  readonly animations?: Readonly<Record<PetVisualState, AnimationDefinition>>;
  readonly animation?: AnimationControllerOptions;
}

export class SpriteRenderer {
  readonly controller: AnimationController;
  private readonly animations: Readonly<Record<PetVisualState, AnimationDefinition>>;
  private smoothing = false;

  constructor(options: SpriteRendererOptions = {}) {
    this.animations = options.animations ?? DEFAULT_ANIMATIONS;
    this.controller = new AnimationController({
      ...options.animation,
      animations: this.animations,
    });
  }

  set smoothingEnabled(value: boolean) {
    this.smoothing = value;
  }

  get smoothingEnabled(): boolean {
    return this.smoothing;
  }

  setDesiredState(state: PetVisualState, options?: { celebrate?: boolean; now?: number }): void {
    this.controller.setDesiredState(state, options);
  }

  reset(state: PetVisualState = "idle"): void {
    this.controller.reset(state);
  }

  /** Advance playback; call only while visible (perf: no loop when hidden). */
  update(deltaMs: number): void {
    this.controller.update(deltaMs);
  }

  /**
   * Draw the current animation frame into the context.
   *
   * `x`, `y`, `width`, `height` are the destination rect in the canvas
   * coordinate space (CSS px); the source cell is scaled to fit. The
   * destination bottom edge is the sprite baseline, so callers should anchor
   * the rect to the pet's feet (spec §33).
   */
  render(
    ctx: CanvasRenderingContext2D,
    options: {
      readonly image: CanvasImageSource;
      readonly x?: number;
      readonly y?: number;
      readonly width: number;
      readonly height: number;
      readonly opacity?: number;
      /** Render a specific state/frame instead of the controller's current one. */
      readonly override?: { readonly state: PetVisualState; readonly frame: number };
    },
  ): void {
    const { image, x = 0, y = 0, width, height, opacity = 1 } = options;
    const state = options.override?.state ?? this.controller.state;
    const frame = options.override?.frame ?? this.controller.frame;
    const rect = frameSourceRect(state, frame, this.animations);

    ctx.save();
    if (!this.smoothing) {
      ctx.imageSmoothingEnabled = false;
    }
    if (opacity < 1) {
      ctx.globalAlpha = opacity;
    }
    ctx.drawImage(image, rect.sx, rect.sy, rect.sw, rect.sh, x, y, width, height);
    ctx.restore();
  }
}
