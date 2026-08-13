import { DEFAULT_ANIMATIONS, type PetVisualState } from "./atlas.ts";

/** Minimum fraction of a used cell that must be opaque to count as populated. */
export const MIN_POPULATED_CELL_FRACTION = 0.01;

export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  /** RGBA pixel data, 4 bytes per pixel, row-major. */
  readonly data: Uint8ClampedArray;
}

export interface PetValidationIssue {
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly message: string;
}

export interface PetValidationResult {
  readonly ok: boolean;
  readonly errors: readonly PetValidationIssue[];
  readonly warnings: readonly PetValidationIssue[];
  readonly atlas: {
    readonly width: number;
    readonly height: number;
    readonly cellWidth: number;
    readonly cellHeight: number;
    readonly rows: number;
    readonly columns: number;
  };
}

/**
 * Deterministic package validation (spec §52, §55). Input is the decoded
 * manifest plus decoded sprite pixels, so the same logic runs in the browser
 * (canvas decode) and in tooling (sharp decode) with no environment coupling.
 * Errors are actionable: "spritesheet.webp has dimensions 1024x1024. Expected
 * 1536x1872 for sprite version 1."
 */
export function validatePetAtlas(input: {
  readonly manifest: { readonly spriteVersionNumber: number };
  readonly image: DecodedImage;
  readonly animations?: Readonly<
    Record<PetVisualState, { readonly row: number; readonly frames: number }>
  >;
}): PetValidationResult {
  const errors: PetValidationIssue[] = [];
  const warnings: PetValidationIssue[] = [];

  const { width, height, data } = input.image;
  const { spriteVersionNumber } = input.manifest;
  const animations = input.animations ?? DEFAULT_ANIMATIONS;

  if (spriteVersionNumber !== 1) {
    errors.push({
      code: "sprite.version.unsupported",
      severity: "error",
      message: `spritesheet version ${spriteVersionNumber} is not supported. Expected sprite version 1.`,
    });
  }

  const expectedWidth = 1536;
  const expectedHeight = 1872;
  const cellWidth = 192;
  const cellHeight = 208;
  const columns = 8;
  const rows = 9;

  if (width !== expectedWidth || height !== expectedHeight) {
    errors.push({
      code: "atlas.dimensions",
      severity: "error",
      message: `spritesheet has dimensions ${width}x${height}. Expected ${expectedWidth}x${expectedHeight} for sprite version 1.`,
    });
  }

  // The checks below need cell addressing; bail with the dimension error if the
  // grid cannot be addressed.
  if (width === expectedWidth && height === expectedHeight && data.length >= width * height * 4) {
    const alphaAt = (x: number, y: number): number => data[(y * width + x) * 4 + 3] ?? 0;

    // Transparency must exist somewhere (spec: transparent background, cut out).
    let hasTransparency = false;
    for (let i = 3; i < data.length; i += 4) {
      if ((data[i] ?? 255) < 255) {
        hasTransparency = true;
        break;
      }
    }
    if (!hasTransparency) {
      errors.push({
        code: "atlas.no-transparency",
        severity: "error",
        message:
          "spritesheet has no transparent pixels; the pet must be cut out of its background.",
      });
    }

    // Transparent pixels must carry no hidden RGB residue.
    let residuePixels = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        const alpha = data[offset + 3] ?? 0;
        const r = data[offset] ?? 0;
        const g = data[offset + 1] ?? 0;
        const b = data[offset + 2] ?? 0;
        if (alpha === 0 && (r !== 0 || g !== 0 || b !== 0)) {
          residuePixels += 1;
        }
      }
    }
    if (residuePixels > 0) {
      warnings.push({
        code: "atlas.transparent-residue",
        severity: "warning",
        message: `${residuePixels} transparent pixels carry hidden RGB data; clear them for a clean alpha channel.`,
      });
    }

    // Used cells populated, unused cells fully transparent (spec §23, §52).
    for (const state of Object.keys(animations) as PetVisualState[]) {
      const animation = animations[state];
      if (animation === undefined) {
        continue;
      }
      const row = animation.row;
      for (let column = 0; column < columns; column += 1) {
        const isUsed = column < animation.frames;
        const cellMinPopulated = Math.floor(cellWidth * cellHeight * MIN_POPULATED_CELL_FRACTION);
        let opaque = 0;
        let hasVisible = false;
        for (let y = row * cellHeight; y < (row + 1) * cellHeight; y += 1) {
          for (let x = column * cellWidth; x < (column + 1) * cellWidth; x += 1) {
            const alpha = alphaAt(x, y);
            if (alpha > 0) {
              hasVisible = true;
              if (alpha === 255) {
                opaque += 1;
              }
            }
          }
        }
        if (isUsed && !hasVisible) {
          errors.push({
            code: "atlas.empty-used-cell",
            severity: "error",
            message: `row ${row} column ${column} (state "${state}") is empty; every used cell must contain the animation frame.`,
          });
        } else if (isUsed && opaque < cellMinPopulated) {
          warnings.push({
            code: "atlas.sparse-used-cell",
            severity: "warning",
            message: `row ${row} column ${column} (state "${state}") is mostly empty; the frame may render as a barely visible sprite.`,
          });
        }
        if (!isUsed && hasVisible) {
          errors.push({
            code: "atlas.unused-cell-visible",
            severity: "error",
            message: `row ${row} column ${column} is marked unused but contains visible pixels; unused cells must be fully transparent.`,
          });
        }
      }
    }
  }

  const result: PetValidationResult = {
    ok: errors.length === 0,
    errors,
    warnings,
    atlas: {
      width: expectedWidth,
      height: expectedHeight,
      cellWidth,
      cellHeight,
      rows,
      columns,
    },
  };
  return result;
}
