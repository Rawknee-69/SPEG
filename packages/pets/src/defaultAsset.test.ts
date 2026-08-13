// @effect-diagnostics nodeBuiltinImport:off - reads the committed web asset for QA validation.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import sharp from "sharp";

import { validatePetAtlas } from "./validator.ts";

/**
 * QA gate for the committed default pet atlas (spec §52, §112): the built-in
 * sprite sheet must deterministically validate or the build surface is broken.
 * Regenerate with `node scripts/generate-default-pet.mjs`.
 */
const DEFAULT_PET_WEBP = fileURLToPath(
  new URL("../../../apps/web/src/assets/pets/default.webp", import.meta.url),
);

describe("default pet asset", () => {
  it("is present in the web app assets", () => {
    const buffer = readFileSync(DEFAULT_PET_WEBP);
    expect(buffer.length).toBeGreaterThan(0);
  });

  it("validates as a V1 sprite atlas", async () => {
    const { data, info } = await sharp(DEFAULT_PET_WEBP)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const result = validatePetAtlas({
      manifest: { spriteVersionNumber: 1 },
      image: {
        width: info.width,
        height: info.height,
        data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
      },
    });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
