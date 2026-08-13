/**
 * V1 sprite-atlas contract for SPEG pets.
 *
 * The V1 atlas is an 8-column x 9-row sheet of 192x208 cells (1536x1872 total),
 * with a fixed row -> state mapping. Every row has a fixed frame count; unused
 * cells must be fully transparent. Row layout and frame counts are versioned
 * constants here so the runtime and the validator never disagree (spec §23, §126).
 */

export const ATLAS_VERSION_V1 = 1;

export const ATLAS_COLUMNS = 8;
export const ATLAS_ROWS = 9;
export const CELL_WIDTH = 192;
export const CELL_HEIGHT = 208;
export const ATLAS_WIDTH = ATLAS_COLUMNS * CELL_WIDTH; // 1536
export const ATLAS_HEIGHT = ATLAS_ROWS * CELL_HEIGHT; // 1872

export const PET_VISUAL_STATES = [
  "idle",
  "running-right",
  "running-left",
  "waving",
  "jumping",
  "failed",
  "waiting",
  "running",
  "review",
] as const;
export type PetVisualState = (typeof PET_VISUAL_STATES)[number];

/** Animation timing/loop metadata for one visual state. */
export interface AnimationDefinition {
  /** Row index in the atlas. */
  readonly row: number;
  /** Number of populated frames in the row. */
  readonly frames: number;
  /** Frames per second while playing. */
  readonly fps: number;
  /** Whether the animation loops indefinitely (true) or plays once (false). */
  readonly loop: boolean;
}

/**
 * Default V1 timing table (spec §23, §30). Stored centrally so the runtime can
 * tune animations without touching assets.
 */
export const DEFAULT_ANIMATIONS: Readonly<Record<PetVisualState, AnimationDefinition>> = {
  idle: { row: 0, frames: 6, fps: 10, loop: true },
  "running-right": { row: 1, frames: 8, fps: 10, loop: true },
  "running-left": { row: 2, frames: 8, fps: 10, loop: true },
  waving: { row: 3, frames: 4, fps: 10, loop: true },
  jumping: { row: 4, frames: 5, fps: 12, loop: false },
  failed: { row: 5, frames: 8, fps: 10, loop: false },
  waiting: { row: 6, frames: 6, fps: 8, loop: true },
  running: { row: 7, frames: 6, fps: 10, loop: true },
  review: { row: 8, frames: 8, fps: 10, loop: true },
};

/** Source rectangle of one animation frame inside the atlas. */
export interface FrameSourceRect {
  readonly sx: number;
  readonly sy: number;
  readonly sw: number;
  readonly sh: number;
}

export function frameSourceRect(
  state: PetVisualState,
  frame: number,
  animations: Readonly<Record<PetVisualState, AnimationDefinition>> = DEFAULT_ANIMATIONS,
): FrameSourceRect {
  const animation = animations[state];
  const clamped = Math.min(Math.max(0, frame), animation.frames - 1);
  return {
    sx: clamped * CELL_WIDTH,
    sy: animation.row * CELL_HEIGHT,
    sw: CELL_WIDTH,
    sh: CELL_HEIGHT,
  };
}

/** Base logical render height (CSS px) for scale = 1; "normal" per spec §34. */
export const BASE_RENDER_HEIGHT = 96;

export function renderSize(
  scale: number,
  baseHeight: number = BASE_RENDER_HEIGHT,
): { readonly width: number; readonly height: number } {
  const height = baseHeight * scale;
  const width = (height * CELL_WIDTH) / CELL_HEIGHT;
  return { width, height };
}
