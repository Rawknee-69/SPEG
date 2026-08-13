import { DEFAULT_ANIMATIONS, type AnimationDefinition, type PetVisualState } from "./atlas.ts";

/**
 * Frame playback + transition rules (spec §27-31, §63-64).
 *
 * - Event debouncing: requesting the state that is already playing is a no-op.
 * - Transient animations (waving, jumping) are non-destructive: when they
 *   finish, the controller falls back to the pending target state.
 * - Celebration cooldown prevents "jump jump jump" fatigue (§97).
 * - One-shot animations (jumping, failed) play once and then hold their final
 *   frame (failed) or hand off to the pending target (jumping).
 */
export interface AnimationControllerOptions {
  readonly animations?: Readonly<Record<PetVisualState, AnimationDefinition>>;
  /** Minimum ms between celebrations (spec §97 default 20s). */
  readonly celebrationCooldownMs?: number;
  /** Called once when a one-shot animation reaches its final frame. */
  readonly onAnimationComplete?: (state: PetVisualState) => void;
}

export const DEFAULT_CELEBRATION_COOLDOWN_MS = 20_000;

export interface AnimationSnapshot {
  readonly state: PetVisualState;
  readonly frame: number;
  readonly totalFrames: number;
  readonly fps: number;
  readonly loop: boolean;
  readonly playingOneShot: boolean;
}

export class AnimationController {
  private readonly animations: Readonly<Record<PetVisualState, AnimationDefinition>>;
  private readonly celebrationCooldownMs: number;
  private readonly onAnimationComplete: ((state: PetVisualState) => void) | undefined;

  private current: PetVisualState = "idle";
  private frameIndex = 0;
  private elapsedMs = 0;
  private lastCelebrationAt = Number.NEGATIVE_INFINITY;
  private pendingTarget: PetVisualState | null = null;
  private completionNotified = false;

  constructor(options: AnimationControllerOptions = {}) {
    this.animations = options.animations ?? DEFAULT_ANIMATIONS;
    this.celebrationCooldownMs = options.celebrationCooldownMs ?? DEFAULT_CELEBRATION_COOLDOWN_MS;
    this.onAnimationComplete = options.onAnimationComplete;
  }

  get state(): PetVisualState {
    return this.current;
  }

  get frame(): number {
    return this.frameIndex;
  }

  get animation(): AnimationDefinition {
    return this.animations[this.current];
  }

  snapshot(): AnimationSnapshot {
    const animation = this.animation;
    return {
      state: this.current,
      frame: this.frame,
      totalFrames: animation.frames,
      fps: animation.fps,
      loop: animation.loop,
      playingOneShot: !animation.loop,
    };
  }

  /**
   * Request a visual state. Same-state requests are ignored (debounce); only
   * meaningful transitions change the animation (spec §63-64).
   *
   * `celebrate` plays a non-destructive jumping animation first (subject to the
   * cooldown) before settling into the target — used for task completion
   * (§29, §98). Blocking states never celebrate.
   */
  setDesiredState(state: PetVisualState, options?: { celebrate?: boolean; now?: number }): void {
    if (state === this.current) {
      return;
    }

    // Without an explicit clock the pet never celebrates; celebrations require
    // a monotonic `now` from the caller (tests pass a fixed time).
    const now = options?.now ?? Number.NEGATIVE_INFINITY;
    const wantsCelebration =
      options?.celebrate === true &&
      state !== "waiting" &&
      state !== "failed" &&
      this.canCelebrate(now);
    if (wantsCelebration) {
      this.lastCelebrationAt = now;
      this.pendingTarget = state;
      this.startAnimation("jumping");
      return;
    }

    // Interrupt any in-flight transient (e.g. the task fails mid-celebration).
    this.pendingTarget = null;
    this.startAnimation(state);
  }

  /** Reset to the given state without any transition rules. */
  reset(state: PetVisualState = "idle"): void {
    this.pendingTarget = null;
    this.startAnimation(state);
  }

  /** Advance playback by `deltaMs` (call only while visible/animating). */
  update(deltaMs: number): void {
    if (deltaMs <= 0) {
      return;
    }
    const animation = this.animations[this.current];
    const frameDurationMs = 1000 / animation.fps;
    this.elapsedMs += deltaMs;

    while (this.elapsedMs >= frameDurationMs && this.frameIndex < animation.frames) {
      this.elapsedMs -= frameDurationMs;
      if (this.frameIndex < animation.frames - 1) {
        this.frameIndex += 1;
        continue;
      }
      if (animation.loop) {
        this.frameIndex = 0;
        continue;
      }
      // One-shot reached its final frame: notify once, then hand off to the
      // pending target (transient) or hold the final frame (failed).
      if (!this.completionNotified) {
        this.completionNotified = true;
        this.onAnimationComplete?.(this.current);
      }
      if (this.pendingTarget !== null && this.pendingTarget !== this.current) {
        const target = this.pendingTarget;
        this.pendingTarget = null;
        this.startAnimation(target);
      }
      break;
    }
  }

  /** Whether a celebration is allowed right now (cooldown elapsed). */
  canCelebrate(now: number): boolean {
    return now - this.lastCelebrationAt >= this.celebrationCooldownMs;
  }

  private startAnimation(state: PetVisualState): void {
    this.current = state;
    this.frameIndex = 0;
    this.elapsedMs = 0;
    this.completionNotified = false;
  }
}
