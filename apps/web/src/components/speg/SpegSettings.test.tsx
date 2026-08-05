import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import type { ClientSettingsPatch, SpegSettings } from "@t3tools/contracts/settings";
import { DEFAULT_SPEG_SETTINGS } from "@t3tools/contracts/settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  AGENT_WATCH_LABELS,
  WATCH_AGENT_ORDER,
  parsePort,
  parseTokenBudget,
  parseWatchPathList,
  watchPathListToText,
} from "./SpegSettings.logic";
import {
  DraftNumberInput,
  DraftTextInput,
  SpegSettings as SpegSettingsPanel,
  WatchPathsEditor,
} from "./SpegSettings";
import { Select } from "../ui/select";
import { SettingsSection } from "../settings/settingsLayout";

// Slot-based react hooks harness (repo pattern for compiled components; see
// CacmPanel.test.tsx). Only the top-level component's own hooks run — nested
// components render as element descriptors and are inspected via the tree
// walkers below.
const hooks = vi.hoisted(() => {
  let cursor = 0;
  let slots: unknown[] = [];

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      cursor = 0;
      slots = [];
    },
    useCallback<T>(callback: T): T {
      cursor += 1;
      return callback;
    },
    useEffect(callback: () => void | (() => void)): void {
      cursor += 1;
      // Effects are never run in this harness; onBlur handlers commit drafts.
      void callback;
    },
    useMemo<T>(factory: () => T): T {
      const index = cursor++;
      if (!slots[index]) {
        slots[index] = factory();
      }
      return slots[index] as T;
    },
    useMemoCache(size: number): unknown[] {
      const index = cursor++;
      if (!slots[index]) {
        slots[index] = Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel"));
      }
      return slots[index] as unknown[];
    },
    useState<T>(initialValue: T | (() => T)): [T, (nextValue: T | ((value: T) => T)) => void] {
      const index = cursor++;
      if (index >= slots.length) {
        slots[index] =
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
      }
      const setValue = (nextValue: T | ((value: T) => T)) => {
        const previous = slots[index] as T;
        slots[index] =
          typeof nextValue === "function" ? (nextValue as (value: T) => T)(previous) : nextValue;
      };
      return [slots[index] as T, setValue];
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: hooks.useCallback,
    useEffect: hooks.useEffect,
    useMemo: hooks.useMemo,
    useState: hooks.useState,
  };
});

vi.mock("react/compiler-runtime", () => ({
  c: hooks.useMemoCache,
}));

const testState = vi.hoisted(() => {
  const state = {
    speg: null as SpegSettings | null,
    updateCalls: [] as Array<ClientSettingsPatch>,
    updateSettings: null as unknown as (patch: ClientSettingsPatch) => void,
  };
  state.updateSettings = (patch: ClientSettingsPatch) => {
    state.updateCalls.push(patch);
    if (patch.speg) state.speg = patch.speg;
  };
  return state;
});

vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (
    selector?: ((settings: { speg: SpegSettings | null }) => unknown) | undefined,
  ) => (selector ? selector({ speg: testState.speg }) : { speg: testState.speg }),
  useUpdateClientSettings: () => testState.updateSettings,
}));

// ---------------------------------------------------------------------------
// Element-tree helpers (no DOM in this suite; components are invoked directly)
//
// Settings panels compose via element *props* (`SettingsRow` gets `control`,
// `SettingsSection` gets `title`/`icon`), so the walker descends into
// element-valued props as well as `children`.
// ---------------------------------------------------------------------------

function walk(node: ReactNode, visit: (element: ReactElement) => void): void {
  const visitNode = (current: ReactNode) => {
    for (const child of Children.toArray(current)) {
      if (!isValidElement(child)) continue;
      visit(child);
      const props = (child.props ?? {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(props)) {
        if (key === "children" || key === "key" || key === "ref") continue;
        if (isValidElement(value)) visitNode(value);
        else if (Array.isArray(value)) visitNode(value as ReactNode);
      }
      visitNode((child.props as { children?: ReactNode }).children);
    }
  };
  visitNode(node);
}

function findByAriaLabel(node: ReactNode, label: string): ReactElement | null {
  let found: ReactElement | null = null;
  walk(node, (element) => {
    if (found) return;
    const props = element.props as { "aria-label"?: string; ariaLabel?: string };
    if (props["aria-label"] === label || props.ariaLabel === label) {
      found = element;
    }
  });
  return found;
}

function findByType(node: ReactNode, type: unknown): ReactElement | null {
  let found: ReactElement | null = null;
  walk(node, (element) => {
    if (!found && element.type === type) {
      found = element;
    }
  });
  return found;
}

function collectPropText(node: ReactNode, key: string): string[] {
  const parts: string[] = [];
  walk(node, (element) => {
    const value = (element.props as Record<string, unknown>)[key];
    if (typeof value === "string") parts.push(value);
  });
  return parts;
}

function renderSettings(): ReactElement {
  hooks.beginRender();
  return SpegSettingsPanel() as ReactElement;
}

function renderDraftInput(props: {
  value: string;
  onCommit: (next: string) => void;
  ariaLabel: string;
}): ReactElement {
  hooks.beginRender();
  return DraftTextInput(props) as ReactElement;
}

/** Re-invoke a draft editor so its closures see the draft set by the last change. */
function reRender<T>(component: (props: T) => ReactElement, props: T): ReactElement {
  hooks.beginRender();
  return component(props) as ReactElement;
}

beforeEach(() => {
  hooks.reset();
  testState.speg = structuredClone(DEFAULT_SPEG_SETTINGS);
  testState.updateCalls = [];
});

afterEach(() => {
  hooks.reset();
});

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

describe("SpegSettings.logic", () => {
  it("parses watch paths into trimmed non-empty lines", () => {
    expect(parseWatchPathList("/a\n  /b \n\n/c\r\n")).toEqual(["/a", "/b", "/c"]);
    expect(parseWatchPathList("   \n\n")).toEqual([]);
    expect(watchPathListToText(["/a", "/b"])).toBe("/a\n/b");
    expect(parseWatchPathList(watchPathListToText(["/a", "/b"]))).toEqual(["/a", "/b"]);
  });

  it("validates ports and token budgets", () => {
    expect(parsePort("9786")).toBe(9786);
    expect(parsePort("0")).toBeNull();
    expect(parsePort("65536")).toBeNull();
    expect(parsePort("abc")).toBeNull();
    expect(parsePort("3.5")).toBeNull();
    expect(parseTokenBudget("8000")).toBe(8000);
    expect(parseTokenBudget("0")).toBe(0);
    expect(parseTokenBudget("-1")).toBeNull();
    expect(parseTokenBudget("1.5")).toBeNull();
  });

  it("labels every watchable agent", () => {
    expect(WATCH_AGENT_ORDER).toHaveLength(6);
    for (const agent of WATCH_AGENT_ORDER) {
      expect(AGENT_WATCH_LABELS[agent]).toBeTruthy();
    }
    expect(AGENT_WATCH_LABELS.codex).toBe("Codex");
    expect(AGENT_WATCH_LABELS["claude-code"]).toBe("Claude Code");
  });
});

// ---------------------------------------------------------------------------
// Panel rendering
// ---------------------------------------------------------------------------

describe("SpegSettings", () => {
  it("renders every SPEG section", () => {
    const titles = collectPropText(renderSettings(), "title");
    for (const title of ["Jcode", "CACM daemon", "Context injection", "Agent watching", "Skills"]) {
      expect(titles).toContain(title);
    }
  });

  it("renders all six agent toggles, checked by default", () => {
    const tree = renderSettings();
    for (const agent of WATCH_AGENT_ORDER) {
      const toggle = findByAriaLabel(tree, `Watch ${AGENT_WATCH_LABELS[agent]} sessions`);
      expect(toggle).not.toBeNull();
      expect((toggle!.props as { checked: boolean }).checked).toBe(true);
    }
  });

  it("toggles an agent off by replacing the whole speg blob", () => {
    const tree = renderSettings();
    const codexToggle = findByAriaLabel(tree, "Watch Codex sessions")!;
    (codexToggle.props as { onCheckedChange: (next: boolean) => void }).onCheckedChange(false);

    expect(testState.updateCalls).toHaveLength(1);
    const patch = testState.updateCalls[0]!;
    expect(patch.speg).toEqual({
      ...testState.speg,
      watchedAgents: { ...DEFAULT_SPEG_SETTINGS.watchedAgents, codex: false },
    });
    expect(patch.speg!.watchedAgents.codex).toBe(false);
    expect(patch.speg!.watchedAgents.jcode).toBe(true);
  });

  it("re-renders the toggled agent as off", () => {
    const tree = renderSettings();
    const codexToggle = findByAriaLabel(tree, "Watch Codex sessions")!;
    (codexToggle.props as { onCheckedChange: (next: boolean) => void }).onCheckedChange(false);

    const updated = renderSettings();
    expect(
      (findByAriaLabel(updated, "Watch Codex sessions")!.props as { checked: boolean }).checked,
    ).toBe(false);
  });

  it("changes the binary path mode via the select", () => {
    const tree = renderSettings();
    const select = findByType(tree, Select)!;
    expect(select.props as { value: string }).toMatchObject({ value: "auto" });
    (select.props as { onValueChange: (next: string) => void }).onValueChange("manual");

    expect(testState.updateCalls[0]!.speg!.jcodeBinaryPathMode).toBe("manual");
  });

  it("reveals the manual binary path input only in manual mode", () => {
    const autoTree = renderSettings();
    expect(findByAriaLabel(autoTree, "Jcode binary path")).toBeNull();
    expect(findByAriaLabel(autoTree, "Jcode build command")).not.toBeNull();

    testState.speg = {
      ...structuredClone(DEFAULT_SPEG_SETTINGS),
      jcodeBinaryPathMode: "manual",
    };
    const pathInput = findByAriaLabel(renderSettings(), "Jcode binary path");
    expect(pathInput).not.toBeNull();
    expect((pathInput!.props as { value: string }).value).toBe("");
  });

  it("changes the context injection mode", () => {
    const tree = renderSettings();
    const selects = [] as ReactElement[];
    walk(tree, (element) => {
      if (element.type === Select) selects.push(element);
    });
    expect(selects).toHaveLength(3);
    // Selects render in order: binary mode, storage backend, injection mode.
    const injectionSelect = selects[2]!;
    (injectionSelect.props as { onValueChange: (next: string) => void }).onValueChange("off");

    expect(testState.updateCalls[0]!.speg!.contextInjectionMode).toBe("off");
  });

  it("shows the skills placeholder when no skills are registered", () => {
    const descriptions = collectPropText(renderSettings(), "description");
    expect(descriptions.some((text) => text.includes("Phase 3"))).toBe(true);
  });

  it("renders registered skill toggles from the skillToggles blob", () => {
    testState.speg = {
      ...structuredClone(DEFAULT_SPEG_SETTINGS),
      skillToggles: { "context-reminder": true },
    };
    const tree = renderSettings();
    const toggle = findByAriaLabel(tree, "Enable context-reminder skill");
    expect(toggle).not.toBeNull();
    expect((toggle!.props as { checked: boolean }).checked).toBe(true);

    (toggle!.props as { onCheckedChange: (next: boolean) => void }).onCheckedChange(false);
    expect(testState.updateCalls[0]!.speg!.skillToggles["context-reminder"]).toBe(false);
  });

  it("registers five SPEG sections in the settings catalog", () => {
    const sectionIds = [] as string[];
    walk(renderSettings(), (element) => {
      if (element.type === SettingsSection) {
        sectionIds.push((element.props as { id: string }).id);
      }
    });
    expect(sectionIds).toEqual([
      "speg-jcode",
      "speg-cacm",
      "speg-context-injection",
      "speg-agent-watching",
      "speg-skills",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Draft editors (commit-on-blur semantics)
// ---------------------------------------------------------------------------

describe("SpegSettings draft editors", () => {
  it("commits a text draft trimmed, on blur, and only when changed", () => {
    const onCommit = vi.fn();
    const props = { value: "", onCommit, ariaLabel: "Jcode binary path" };
    const input = findByAriaLabel(renderDraftInput(props), "Jcode binary path")!;
    (input.props as { onChange: (event: { target: { value: string } }) => void }).onChange({
      target: { value: "  /tmp/jcode  " },
    });

    // Re-render so the blur closure reads the updated draft (real React would
    // re-render between change and blur).
    const input2 = findByAriaLabel(reRender(DraftTextInput, props), "Jcode binary path")!;
    (input2.props as { onBlur: () => void }).onBlur();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("/tmp/jcode");
  });

  it("does not commit an unchanged draft on blur", () => {
    const onCommit = vi.fn();
    const props = { value: "/tmp/jcode", onCommit, ariaLabel: "Jcode binary path" };
    const input = findByAriaLabel(renderDraftInput(props), "Jcode binary path")!;
    (input.props as { onChange: (event: { target: { value: string } }) => void }).onChange({
      target: { value: "/tmp/jcode  " },
    });
    const input2 = findByAriaLabel(reRender(DraftTextInput, props), "Jcode binary path")!;
    (input2.props as { onBlur: () => void }).onBlur();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits a valid number on change and ignores invalid input", () => {
    const onCommit = vi.fn();
    hooks.beginRender();
    const tree = DraftNumberInput({
      value: 9786,
      onCommit,
      parse: parsePort,
      ariaLabel: "CACM daemon port",
    }) as ReactElement;

    const input = findByAriaLabel(tree, "CACM daemon port")!;
    const change = (value: string) =>
      (input.props as { onChange: (event: { target: { value: string } }) => void }).onChange({
        target: { value },
      });

    change("9790");
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(9790);

    onCommit.mockClear();
    change("99999");
    change("abc");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("parses the watch-paths editor into a path list on blur", () => {
    const onCommit = vi.fn();
    const props = { value: [] as string[], onCommit, ariaLabel: "CACM watch paths" };
    hooks.beginRender();
    const textarea = findByAriaLabel(WatchPathsEditor(props) as ReactElement, "CACM watch paths")!;
    (textarea.props as { onChange: (event: { target: { value: string } }) => void }).onChange({
      target: { value: "/a\n  /b \n\n/c" },
    });

    const textarea2 = findByAriaLabel(
      reRender(WatchPathsEditor, props) as ReactElement,
      "CACM watch paths",
    )!;
    (textarea2.props as { onBlur: () => void }).onBlur();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(["/a", "/b", "/c"]);
  });
});
