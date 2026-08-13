import { describe, expect, it } from "vite-plus/test";

import { validateManifest } from "./manifest.ts";

describe("validateManifest", () => {
  it("accepts a minimal valid manifest", () => {
    const result = validateManifest({
      id: "my-pet",
      displayName: "My Pet",
      spritesheetPath: "spritesheet.webp",
    });
    expect(result.ok).toBe(true);
    expect(result.manifest?.spriteVersionNumber).toBe(1);
    expect(result.issues).toEqual([]);
  });

  it("accepts optional fields", () => {
    const result = validateManifest({
      id: "my-pet",
      displayName: "My Pet",
      description: "A small coding companion.",
      spriteVersionNumber: 1,
      spritesheetPath: "spritesheet.webp",
      author: "Example",
      license: "MIT",
      style: "pixel",
      capabilities: { lookDirection: false, interaction: true },
    });
    expect(result.ok).toBe(true);
    expect(result.manifest?.style).toBe("pixel");
    expect(result.manifest?.capabilities?.lookDirection).toBe(false);
  });

  it("rejects an empty manifest with an actionable issue", () => {
    const result = validateManifest({});
    expect(result.ok).toBe(false);
    expect(result.manifest).toBeNull();
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0]?.message).toContain("manifest");
  });

  it("rejects an unsupported sprite version with a clear message", () => {
    const result = validateManifest({
      id: "my-pet",
      displayName: "My Pet",
      spriteVersionNumber: 3,
      spritesheetPath: "spritesheet.webp",
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("sprite.version.unsupported");
    expect(result.issues[0]?.message).toContain("requires sprite version 3");
  });

  it("rejects a missing id", () => {
    const result = validateManifest({ displayName: "My Pet", spritesheetPath: "x" });
    expect(result.ok).toBe(false);
  });
});
