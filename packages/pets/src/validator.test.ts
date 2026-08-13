import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_ANIMATIONS } from "./atlas.ts";
import { validatePetAtlas, type DecodedImage } from "./validator.ts";

const ATLAS_WIDTH = 1536;
const ATLAS_HEIGHT = 1872;
const CELL_WIDTH = 192;
const CELL_HEIGHT = 208;
const COLUMNS = 8;
const ROWS = 9;

interface MakeImageOptions {
  readonly width?: number;
  readonly height?: number;
  /** Linear cell indices (row*8+col) to leave empty even though used. */
  readonly skipCells?: readonly number[];
  /** Linear cell indices to fill with opaque pixels even though unused. */
  readonly fillUnused?: readonly number[];
  /** Fill the whole image opaque (no transparency at all). */
  readonly fullyOpaque?: boolean;
  /** Give one fully transparent pixel hidden RGB residue. */
  readonly residuePixel?: boolean;
  /** Only paint this many opaque pixels in the cell (sparse). */
  readonly sparseCells?: readonly number[];
}

function makeImage(options: MakeImageOptions = {}): DecodedImage {
  const width = options.width ?? ATLAS_WIDTH;
  const height = options.height ?? ATLAS_HEIGHT;
  const data = new Uint8ClampedArray(width * height * 4);

  if (options.fullyOpaque) {
    data.fill(255);
    return { width, height, data };
  }

  const opaqueRow = new Uint8ClampedArray(CELL_WIDTH * 4).fill(255);
  const usedCells = new Set<number>();
  for (const state of Object.keys(DEFAULT_ANIMATIONS)) {
    const animation = DEFAULT_ANIMATIONS[state as keyof typeof DEFAULT_ANIMATIONS];
    for (let column = 0; column < animation.frames; column += 1) {
      usedCells.add(animation.row * COLUMNS + column);
    }
  }

  const paintCell = (index: number, sparse: boolean) => {
    const row = Math.floor(index / COLUMNS);
    const column = index % COLUMNS;
    if (row * CELL_HEIGHT + CELL_HEIGHT > height || column * CELL_WIDTH + CELL_WIDTH > width) {
      return; // cell does not fit in this (possibly non-standard) image
    }
    if (!sparse) {
      for (let y = 0; y < CELL_HEIGHT; y += 1) {
        data.set(opaqueRow, ((row * CELL_HEIGHT + y) * width + column * CELL_WIDTH) * 4);
      }
      return;
    }
    for (let pixel = 0; pixel < 10; pixel += 1) {
      const x = column * CELL_WIDTH + (pixel % CELL_WIDTH);
      const y = row * CELL_HEIGHT + Math.floor(pixel / CELL_WIDTH);
      const offset = (y * width + x) * 4;
      data[offset] = 200;
      data[offset + 1] = 120;
      data[offset + 2] = 60;
      data[offset + 3] = 255;
    }
  };

  for (let index = 0; index < ROWS * COLUMNS; index += 1) {
    if (
      usedCells.has(index) &&
      !(options.skipCells ?? []).includes(index) &&
      !(options.sparseCells ?? []).includes(index)
    ) {
      paintCell(index, false);
    }
  }
  for (const index of options.fillUnused ?? []) {
    paintCell(index, false);
  }
  for (const index of options.sparseCells ?? []) {
    paintCell(index, true);
  }

  if (options.residuePixel) {
    // Fully transparent pixel inside the unused cell at row 0, column 6
    // (idle uses only 6 of 8 columns) carrying hidden RGB data.
    const residueIndex = ((0 * CELL_HEIGHT + 10) * width + (6 * CELL_WIDTH + 10)) * 4;
    data[residueIndex] = 255;
    data[residueIndex + 1] = 128;
    data[residueIndex + 2] = 0;
  }

  return { width, height, data };
}

describe("validatePetAtlas", () => {
  it("accepts a valid atlas", () => {
    const result = validatePetAtlas({ manifest: { spriteVersionNumber: 1 }, image: makeImage() });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.atlas).toEqual({
      width: ATLAS_WIDTH,
      height: ATLAS_HEIGHT,
      cellWidth: CELL_WIDTH,
      cellHeight: CELL_HEIGHT,
      rows: ROWS,
      columns: COLUMNS,
    });
  });

  it("rejects wrong dimensions with an actionable message", () => {
    const result = validatePetAtlas({
      manifest: { spriteVersionNumber: 1 },
      image: makeImage({ width: 1024, height: 1024 }),
    });
    expect(result.ok).toBe(false);
    const dimensionError = result.errors.find((issue) => issue.code === "atlas.dimensions");
    expect(dimensionError?.message).toContain("1024x1024");
    expect(dimensionError?.message).toContain("1536x1872");
  });

  it("rejects a sheet with no transparency", () => {
    const result = validatePetAtlas({
      manifest: { spriteVersionNumber: 1 },
      image: makeImage({ fullyOpaque: true }),
    });
    expect(result.errors.some((issue) => issue.code === "atlas.no-transparency")).toBe(true);
  });

  it("rejects an empty used cell", () => {
    const result = validatePetAtlas({
      manifest: { spriteVersionNumber: 1 },
      image: makeImage({ skipCells: [0] }), // idle row 0, first frame
    });
    expect(result.ok).toBe(false);
    const issue = result.errors.find((error) => error.code === "atlas.empty-used-cell");
    expect(issue?.message).toContain('state "idle"');
  });

  it("rejects visible pixels in an unused cell", () => {
    const result = validatePetAtlas({
      manifest: { spriteVersionNumber: 1 },
      image: makeImage({ fillUnused: [6] }), // idle row 0, column 6 is unused
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.code === "atlas.unused-cell-visible")).toBe(true);
  });

  it("warns about sparse used cells", () => {
    const result = validatePetAtlas({
      manifest: { spriteVersionNumber: 1 },
      image: makeImage({ sparseCells: [0] }),
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((warning) => warning.code === "atlas.sparse-used-cell")).toBe(true);
  });

  it("warns about transparent RGB residue", () => {
    const result = validatePetAtlas({
      manifest: { spriteVersionNumber: 1 },
      image: makeImage({ residuePixel: true }),
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((warning) => warning.code === "atlas.transparent-residue")).toBe(
      true,
    );
  });

  it("rejects an unsupported sprite version", () => {
    const result = validatePetAtlas({
      manifest: { spriteVersionNumber: 2 },
      image: makeImage(),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.code === "sprite.version.unsupported")).toBe(true);
  });
});
