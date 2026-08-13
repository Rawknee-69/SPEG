#!/usr/bin/env node
/**
 * Generates the built-in default SPEG pet ("Spark") as a V1 sprite atlas.
 *
 * Outputs:
 *   apps/web/src/assets/pets/default.webp      - the 1536x1872 9-state atlas
 *   apps/web/src/assets/pets/contact-sheet.png - labeled contact sheet (QA)
 *   apps/web/src/assets/pets/qa/*.png          - per-state row strips (QA)
 *
 * Run modes:
 *   node scripts/generate-default-pet.mjs        generate + self-validate
 *   node scripts/generate-default-pet.mjs --check validate the committed atlas
 *
 * The pet is drawn procedurally on a 24x26 grid scaled 8x into each 192x208
 * cell, so the output is deterministic and regenerable. Every state shares the
 * same identity (silhouette, palette, feet baseline) per spec §32-33, §51.
 *
 * Note: preview GIFs from the spec's QA list are not generated here — sharp
 * cannot compose animated GIFs from frames; per-state PNG strips serve the same
 * review purpose.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "apps", "web", "src", "assets", "pets");
const QA_DIR = path.join(OUT_DIR, "qa");

const CELL_W = 192;
const CELL_H = 208;
const COLS = 8;
const ROWS = 9;
const ATLAS_W = CELL_W * COLS; // 1536
const ATLAS_H = CELL_H * ROWS; // 1872

const GRID_W = 24;
const GRID_H = 26;
const SCALE = 8;

const STATES = {
  idle: { row: 0, frames: 6 },
  "running-right": { row: 1, frames: 8 },
  "running-left": { row: 2, frames: 8 },
  waving: { row: 3, frames: 4 },
  jumping: { row: 4, frames: 5 },
  failed: { row: 5, frames: 8 },
  waiting: { row: 6, frames: 6 },
  running: { row: 7, frames: 6 },
  review: { row: 8, frames: 8 },
};

const C = {
  outline: [74, 44, 26],
  body: [246, 160, 94],
  dark: [214, 128, 66],
  belly: [255, 227, 194],
  eye: [43, 27, 18],
  tear: [126, 200, 255],
};

// ── Grid drawing helpers ────────────────────────────────────────────

function makeGrid() {
  return Array.from({ length: GRID_H }, () => Array(GRID_W).fill(null));
}

function setPx(grid, x, y, color) {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi >= 0 && xi < GRID_W && yi >= 0 && yi < GRID_H) {
    grid[yi][xi] = color;
  }
}

function fillRect(grid, x0, y0, x1, y1, color) {
  const xa = Math.max(0, Math.min(GRID_W - 1, Math.round(Math.min(x0, x1))));
  const xb = Math.max(0, Math.min(GRID_W - 1, Math.round(Math.max(x0, x1))));
  const ya = Math.max(0, Math.min(GRID_H - 1, Math.round(Math.min(y0, y1))));
  const yb = Math.max(0, Math.min(GRID_H - 1, Math.round(Math.max(y0, y1))));
  for (let y = ya; y <= yb; y += 1) {
    for (let x = xa; x <= xb; x += 1) {
      grid[y][x] = color;
    }
  }
}

function fillEllipse(grid, cx, cy, rx, ry, color) {
  for (let y = Math.ceil(cy - ry); y <= Math.floor(cy + ry); y += 1) {
    for (let x = Math.ceil(cx - rx); x <= Math.floor(cx + rx); x += 1) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) {
        setPx(grid, x, y, color);
      }
    }
  }
}

function fillTriangle(grid, points, color) {
  const [a, b, c] = points;
  const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
  const maxX = Math.min(GRID_W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
  const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
  const maxY = Math.min(GRID_H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
  const sign = (p1, p2, p3) =>
    (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const p = [x + 0.5, y + 0.5];
      const d1 = sign(p, a, b);
      const d2 = sign(p, b, c);
      const d3 = sign(p, c, a);
      const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
      const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
      if (!(hasNeg && hasPos)) {
        grid[y][x] = color;
      }
    }
  }
}

function mirrorGrid(grid) {
  return grid.map((row) => [...row].reverse());
}

// ── Pet drawing ─────────────────────────────────────────────────────

function stateOptions(state, frame) {
  const o = {
    lean: 0,
    y: 0, // upper-body vertical offset (feet stay planted)
    eyesOpen: true,
    blink: false,
    squint: false,
    sad: false,
    tear: false,
    earMode: "up",
    mouth: null,
    arm: "down", // down | wave | typing
    pawFront: false,
    headTilt: 0,
    legs: "normal", // normal | leftUp | rightUp | tucked
  };
  switch (state) {
    case "idle":
      if (frame === 5) o.blink = true;
      if (frame === 3) o.y = -1; // tiny head bob, mostly breathing
      break;
    case "running-right":
      o.lean = 1;
      o.legs = frame % 2 === 0 ? "leftUp" : "rightUp";
      o.y = frame % 2 === 0 ? 0 : -1;
      break;
    case "running-left":
      o.lean = -1;
      o.legs = frame % 2 === 0 ? "rightUp" : "leftUp";
      o.y = frame % 2 === 0 ? 0 : -1;
      break;
    case "waving":
      o.arm = "wave";
      break;
    case "jumping":
      o.y = [1, -2, -6, -2, 0][frame] ?? 0; // compress, rise, peak, fall, recover
      o.legs = "tucked";
      break;
    case "failed":
      o.sad = true;
      o.tear = true;
      o.earMode = "droop";
      o.mouth = "frown";
      o.y = frame >= 2 ? 1 : 0;
      break;
    case "waiting":
      o.pawFront = true;
      o.headTilt = 1;
      o.y = frame % 2 === 0 ? 0 : -1;
      break;
    case "running":
      o.lean = 1;
      o.arm = "typing";
      o.y = frame % 3 === 0 ? -1 : 0;
      break;
    case "review":
      o.headTilt = -1;
      o.squint = true;
      o.y = frame % 4 === 0 ? 0 : -1;
      break;
  }
  return o;
}

function drawPetGrid(state, frame) {
  const o = stateOptions(state, frame);
  const grid = makeGrid();
  const lean = o.lean;
  const tilt = o.headTilt;
  const y = o.y;

  // Ears (behind the head).
  if (o.earMode === "up") {
    fillTriangle(
      grid,
      [
        [5 + lean + tilt, 2],
        [9 + lean + tilt, 2],
        [7 + lean + tilt, 7],
      ],
      C.outline,
    );
    fillTriangle(
      grid,
      [
        [14 + lean + tilt, 2],
        [18 + lean + tilt, 2],
        [16 + lean + tilt, 7],
      ],
      C.outline,
    );
    fillTriangle(
      grid,
      [
        [6 + lean + tilt, 3],
        [8 + lean + tilt, 3],
        [7 + lean + tilt, 6],
      ],
      C.body,
    );
    fillTriangle(
      grid,
      [
        [15 + lean + tilt, 3],
        [17 + lean + tilt, 3],
        [16 + lean + tilt, 6],
      ],
      C.body,
    );
  } else {
    fillRect(grid, 5 + lean + tilt, 3 + y, 9 + lean + tilt, 5 + y, C.outline);
    fillRect(grid, 14 + lean + tilt, 3 + y, 18 + lean + tilt, 5 + y, C.outline);
    fillRect(grid, 6 + lean + tilt, 3 + y, 8 + lean + tilt, 4 + y, C.body);
    fillRect(grid, 15 + lean + tilt, 3 + y, 17 + lean + tilt, 4 + y, C.body);
  }

  // Body: outline then fill so the silhouette stays clean.
  fillEllipse(grid, 12 + lean, 13 + y, 9, 10, C.outline);
  fillEllipse(grid, 12 + lean, 13 + y, 8, 9, C.body);
  fillEllipse(grid, 12 + lean, 18 + y, 5.5, 4.5, C.belly);

  // Legs (feet stay on the baseline at y=24).
  if (o.legs === "tucked") {
    fillRect(grid, 9 + lean, 22, 10 + lean, 23, C.dark);
    fillRect(grid, 13 + lean, 22, 14 + lean, 23, C.dark);
  } else if (o.legs === "leftUp") {
    fillRect(grid, 9 + lean, 19, 10 + lean, 21, C.dark);
    fillRect(grid, 13 + lean, 21, 14 + lean, 24, C.dark);
  } else if (o.legs === "rightUp") {
    fillRect(grid, 9 + lean, 21, 10 + lean, 24, C.dark);
    fillRect(grid, 13 + lean, 19, 14 + lean, 21, C.dark);
  } else {
    fillRect(grid, 9 + lean, 21, 10 + lean, 24, C.dark);
    fillRect(grid, 13 + lean, 21, 14 + lean, 24, C.dark);
  }

  // Arms.
  if (o.arm === "wave") {
    fillRect(grid, 5 + lean, 15 + y, 6 + lean, 17 + y, C.dark);
    fillRect(grid, 17 + lean, 8 + y, 18 + lean, 13 + y, C.dark);
    fillRect(grid, 16 + lean, 7 + y, 19 + lean, 8 + y, C.body);
  } else if (o.arm === "typing") {
    const tip = frame % 2 === 0 ? -1 : 0;
    fillRect(grid, 5 + lean, 15 + y, 6 + lean, 17 + y, C.dark);
    fillRect(grid, 18 + lean, 18 + y + tip, 19 + lean, 20 + y + tip, C.dark);
  } else {
    fillRect(grid, 5 + lean, 15 + y, 6 + lean, 17 + y, C.dark);
    fillRect(grid, 17 + lean, 15 + y, 18 + lean, 17 + y, C.dark);
  }

  // Raised paw (waiting).
  if (o.pawFront) {
    fillRect(grid, 15 + lean + tilt, 14 + y, 16 + lean + tilt, 18 + y, C.dark);
  }

  // Face.
  const eyeY = 11 + y;
  const eyeL = 9 + lean + tilt;
  const eyeR = 13 + lean + tilt;
  if (o.sad) {
    fillRect(grid, eyeL, eyeY + 1, eyeL + 1, eyeY + 2, C.eye);
    fillRect(grid, eyeR, eyeY + 1, eyeR + 1, eyeY + 2, C.eye);
    if (o.tear) {
      fillRect(grid, eyeL - 1, eyeY + 2, eyeL - 1, eyeY + 4, C.tear);
    }
  } else if (o.blink) {
    fillRect(grid, eyeL, eyeY + 1, eyeL + 1, eyeY + 1, C.eye);
    fillRect(grid, eyeR, eyeY + 1, eyeR + 1, eyeY + 1, C.eye);
  } else if (o.squint) {
    fillRect(grid, eyeL, eyeY, eyeL + 1, eyeY + 1, C.eye);
    fillRect(grid, eyeR, eyeY + 1, eyeR + 1, eyeY + 1, C.eye);
  } else {
    fillRect(grid, eyeL, eyeY, eyeL + 1, eyeY + 1, C.eye);
    fillRect(grid, eyeR, eyeY, eyeR + 1, eyeY + 1, C.eye);
  }

  if (o.mouth === "frown") {
    fillRect(grid, 11 + lean, 15 + y, 12 + lean, 15 + y, C.eye);
  } else if (o.sad) {
    fillRect(grid, 11 + lean, 16 + y, 12 + lean, 16 + y, C.eye);
  }

  return grid;
}

// ── Atlas assembly ──────────────────────────────────────────────────

function gridToCellRgba(grid) {
  const buffer = Buffer.alloc(CELL_W * CELL_H * 4);
  for (let gy = 0; gy < GRID_H; gy += 1) {
    for (let gx = 0; gx < GRID_W; gx += 1) {
      const color = grid[gy][gx];
      if (color === null) continue;
      for (let dy = 0; dy < SCALE; dy += 1) {
        for (let dx = 0; dx < SCALE; dx += 1) {
          const px = (gy * SCALE + dy) * CELL_W + gx * SCALE + dx;
          buffer[px * 4] = color[0];
          buffer[px * 4 + 1] = color[1];
          buffer[px * 4 + 2] = color[2];
          buffer[px * 4 + 3] = 255;
        }
      }
    }
  }
  return buffer;
}

function buildAtlasRgba() {
  const buffer = Buffer.alloc(ATLAS_W * ATLAS_H * 4); // fully transparent
  for (const [state, spec] of Object.entries(STATES)) {
    const mirror = state === "running-left";
    for (let frame = 0; frame < spec.frames; frame += 1) {
      let grid = drawPetGrid(state, frame);
      if (mirror) {
        grid = mirrorGrid(grid);
      }
      const cell = gridToCellRgba(grid);
      for (let row = 0; row < CELL_H; row += 1) {
        const src = row * CELL_W * 4;
        const dst = ((spec.row * CELL_H + row) * ATLAS_W + frame * CELL_W) * 4;
        cell.copy(buffer, dst, src, src + CELL_W * 4);
      }
    }
  }
  return buffer;
}

// ── Validation (mirrors packages/pets validator rules) ─────────────

function validateAtlasBuffer(buffer, width, height) {
  const errors = [];
  const warnings = [];
  if (width !== ATLAS_W || height !== ATLAS_H) {
    errors.push(`dimensions ${width}x${height}, expected ${ATLAS_W}x${ATLAS_H}`);
    return { errors, warnings };
  }
  let hasTransparency = false;
  for (let i = 3; i < buffer.length; i += 4) {
    if (buffer[i] < 255) {
      hasTransparency = true;
      break;
    }
  }
  if (!hasTransparency) errors.push("no transparent pixels");
  const alphaAt = (x, y) => buffer[(y * width + x) * 4 + 3];
  for (const [state, spec] of Object.entries(STATES)) {
    for (let column = 0; column < COLS; column += 1) {
      const used = column < spec.frames;
      let visible = 0;
      let opaque = 0;
      for (let y = spec.row * CELL_H; y < (spec.row + 1) * CELL_H; y += 1) {
        for (let x = column * CELL_W; x < (column + 1) * CELL_W; x += 1) {
          const a = alphaAt(x, y);
          if (a > 0) visible += 1;
          if (a === 255) opaque += 1;
        }
      }
      if (used && visible === 0) {
        errors.push(`state "${state}" frame ${column} is empty`);
      } else if (!used && visible > 0) {
        errors.push(`state "${state}" unused cell ${column} has visible pixels`);
      } else if (used && opaque < CELL_W * CELL_H * 0.01) {
        warnings.push(`state "${state}" frame ${column} is sparse`);
      }
    }
  }
  return { errors, warnings };
}

// ── Outputs ─────────────────────────────────────────────────────────

async function writeContactSheet(atlasBuffer) {
  const labels = Object.keys(STATES).map(
    (state, index) =>
      `<text x="8" y="${index * CELL_H + 26}" font-family="monospace" font-size="18" fill="#000">${state}</text>`,
  );
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${ATLAS_W}" height="${ATLAS_H}">${labels.join("")}</svg>`,
  );
  await sharp(atlasBuffer, { raw: { width: ATLAS_W, height: ATLAS_H, channels: 4 } })
    .composite([{ input: svg, top: 0, left: 0 }])
    .png()
    .toFile(path.join(OUT_DIR, "contact-sheet.png"));
}

async function writeStateStrips(atlasBuffer) {
  for (const [state, spec] of Object.entries(STATES)) {
    const strip = Buffer.alloc(CELL_H * CELL_W * spec.frames * 4);
    for (let frame = 0; frame < spec.frames; frame += 1) {
      for (let row = 0; row < CELL_H; row += 1) {
        const src = ((spec.row * CELL_H + row) * ATLAS_W + frame * CELL_W) * 4;
        const dst = (row * CELL_W * spec.frames + frame * CELL_W) * 4;
        atlasBuffer.copy(strip, dst, src, src + CELL_W * 4);
      }
    }
    await sharp(strip, { raw: { width: CELL_W * spec.frames, height: CELL_H, channels: 4 } })
      .png()
      .toFile(path.join(QA_DIR, `${state}.png`));
  }
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(QA_DIR, { recursive: true });

  const target = path.join(OUT_DIR, "default.webp");
  if (checkOnly) {
    const image = sharp(target);
    const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { errors, warnings } = validateAtlasBuffer(data, info.width, info.height);
    report("CHECK", target, errors, warnings);
    process.exit(errors.length === 0 ? 0 : 1);
  }

  const atlas = buildAtlasRgba();
  const { errors, warnings } = validateAtlasBuffer(atlas, ATLAS_W, ATLAS_H);
  if (errors.length > 0) {
    report("GENERATE", "(in-memory)", errors, warnings);
    process.exit(1);
  }

  await sharp(atlas, { raw: { width: ATLAS_W, height: ATLAS_H, channels: 4 } })
    .webp({ lossless: true, quality: 100 })
    .toFile(target);
  await writeContactSheet(atlas);
  await writeStateStrips(atlas);

  report("GENERATE", target, errors, warnings);

  // Re-validate the written file end-to-end.
  const image = sharp(target);
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const recheck = validateAtlasBuffer(data, info.width, info.height);
  report("WRITTEN", target, recheck.errors, recheck.warnings);
  process.exit(recheck.errors.length === 0 ? 0 : 1);
}

function report(step, target, errors, warnings) {
  console.log(`[${step}] ${target}`);
  for (const warning of warnings) console.log(`  warning: ${warning}`);
  if (errors.length === 0) {
    console.log("  PASS");
  } else {
    console.log("  FAIL");
    for (const error of errors) console.log(`  error: ${error}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
