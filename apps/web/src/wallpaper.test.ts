import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { GLASS_THEME, getThemeColorsForMode, getThemeColorVariable } from "./themePalette";
import {
  applyWallpaper,
  clearWallpaper,
  hexToRgb,
  hexToRgbaString,
  parseWallpaperSettings,
  rgbToHex,
  samplesToAccent,
  WALLPAPER_MAX_BLUR,
  WALLPAPER_MAX_DIM,
} from "./wallpaper";

type FakeStyle = {
  props: Map<string, string>;
  setProperty: (name: string, value: string) => void;
  removeProperty: (name: string) => void;
  getPropertyValue: (name: string) => string;
};

function createFakeDocument(themeId = GLASS_THEME.id, isDark = false) {
  const style: FakeStyle = {
    props: new Map<string, string>(),
    setProperty(name, value) {
      style.props.set(name, value);
    },
    removeProperty(name) {
      style.props.delete(name);
    },
    getPropertyValue(name) {
      return style.props.get(name) ?? "";
    },
  };
  const dataset: Record<string, string | undefined> = { themeId };
  const root = {
    style,
    dataset,
    classList: { contains: (className: string) => className === "dark" && isDark },
  };
  return { document: { documentElement: root }, root, style };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseWallpaperSettings", () => {
  it("parses a full settings object", () => {
    const settings = parseWallpaperSettings(
      JSON.stringify({ id: "abc", kind: "video", dim: 40, blur: 8, extractAccent: false }),
    );
    expect(settings).toEqual({ id: "abc", kind: "video", dim: 40, blur: 8, extractAccent: false });
  });

  it("defaults extractAccent to true and clamps dim/blur", () => {
    const settings = parseWallpaperSettings(
      JSON.stringify({ id: "abc", kind: "image", dim: 500, blur: -4 }),
    );
    expect(settings).toEqual({
      id: "abc",
      kind: "image",
      dim: WALLPAPER_MAX_DIM,
      blur: 0,
      extractAccent: true,
    });
  });

  it("rejects malformed values", () => {
    expect(parseWallpaperSettings(null)).toBeNull();
    expect(parseWallpaperSettings("not json")).toBeNull();
    expect(parseWallpaperSettings(JSON.stringify({ kind: "image", dim: 10 }))).toBeNull();
    expect(parseWallpaperSettings(JSON.stringify({ id: "", kind: "image" }))).toBeNull();
    expect(parseWallpaperSettings(JSON.stringify({ id: "a", kind: "audio" }))).toBeNull();
  });
});

describe("color helpers", () => {
  it("round-trips hex colors", () => {
    expect(rgbToHex(hexToRgb("#336699")!)).toBe("#336699");
    expect(hexToRgb("#zzzzzz")).toBeNull();
    expect(hexToRgbaString("#336699", 0.5)).toBe("rgba(51, 102, 153, 0.5)");
    expect(hexToRgbaString("not-a-color", 0.5)).toBeNull();
  });
});

describe("samplesToAccent", () => {
  it("finds a vivid dominant color", () => {
    const samples: Array<[number, number, number]> = [];
    for (let i = 0; i < 400; i += 1) samples.push([30, 90, 220]); // vivid blue
    for (let i = 0; i < 100; i += 1) samples.push([240, 240, 240]); // neutral sky
    const accent = samplesToAccent(samples);
    expect(accent).not.toBeNull();
    const [r, g, b] = hexToRgb(accent!)!;
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(g);
  });

  it("returns null for neutral media", () => {
    const samples = Array.from({ length: 64 }, () => [128, 128, 128] as [number, number, number]);
    expect(samplesToAccent(samples)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(samplesToAccent([])).toBeNull();
  });
});

describe("applyWallpaper / clearWallpaper", () => {
  const settings = { id: "media-1", kind: "image" as const, dim: 40, blur: 8, extractAccent: true };

  it("marks the document and restores the theme accent family when accent matching is off", () => {
    const { root } = createFakeDocument();
    vi.stubGlobal("document", { documentElement: root });

    applyWallpaper({ ...settings, extractAccent: false }, "light", null);

    expect(root.dataset.wallpaper).toBe("image");
    expect(root.style.getPropertyValue("--app-wallpaper-dim")).toBe("0.4");
    expect(root.style.getPropertyValue("--app-wallpaper-blur")).toBe("8px");
    // No regeneration happened; the theme's own accent stays in place.
    const themeAccent = getThemeColorsForMode(GLASS_THEME, "light")!.accent;
    expect(root.style.getPropertyValue(getThemeColorVariable("accent"))).toBe(themeAccent);
  });

  it("regenerates the accent family from the extracted color", () => {
    const { root } = createFakeDocument();
    vi.stubGlobal("document", { documentElement: root });

    applyWallpaper(settings, "light", "#ff5500");

    const themeAccent = getThemeColorsForMode(GLASS_THEME, "light")!.accent;
    expect(root.style.getPropertyValue(getThemeColorVariable("accent"))).not.toBe(themeAccent);
    expect(root.style.getPropertyValue(getThemeColorVariable("messageAction"))).toMatch(
      /^#[0-9a-f]{6}$/i,
    );
  });

  it("restores the theme accent when accent matching is toggled off", () => {
    const { root } = createFakeDocument();
    vi.stubGlobal("document", { documentElement: root });

    applyWallpaper(settings, "light", "#ff5500");
    const regenerated = root.style.getPropertyValue(getThemeColorVariable("accent"));
    expect(regenerated).not.toBe(getThemeColorsForMode(GLASS_THEME, "light")!.accent);

    applyWallpaper({ ...settings, extractAccent: false }, "light", null);
    expect(root.style.getPropertyValue(getThemeColorVariable("accent"))).toBe(
      getThemeColorsForMode(GLASS_THEME, "light")!.accent,
    );

    clearWallpaper();
    expect(root.dataset.wallpaper).toBeUndefined();
    expect(root.style.getPropertyValue(getThemeColorVariable("accent"))).toBe(
      getThemeColorsForMode(GLASS_THEME, "light")!.accent,
    );
  });
});
