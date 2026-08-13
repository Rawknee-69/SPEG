# Pet system (internals)

The pet is an ambient status companion for the agent UI. It renders a sprite
atlas animation that reflects the state of one or more agents. This document
covers how it is built and the performance/failure rules it must obey. User
facing behavior lives in `docs/user/pets.md`.

## Provider-agnostic by construction

All providers (Codex, Claude, Cursor, Grok, OpenCode) are normalized by the
server into `ProviderRuntimeEvent`s, which the projector turns into the
client-facing `OrchestrationThreadShell` read model — the same data the
sidebar and chat render. The pet consumes only that read model, so it works
identically for every provider with **zero per-provider code and zero new
server surface**.

```
Provider CLIs
  → per-provider adapters → ProviderRuntimeEvent
  → projector → OrchestrationThreadShell (per thread)
  → @speg/pets resolver → PetContext → visual state → canvas frames
```

## Where the code lives

- `packages/pets` — framework-free core:
  - `atlas.ts` — the V1 sprite-atlas contract (8×9 cells of 192×208 =
    1536×1872), the 9-state row map, frame-source math, render sizing.
  - `manifest.ts` — `pet.json` schema + graceful versioned validation.
  - `state.ts` — the semantic state vocabulary (17 states) mapped onto the 6
    normalized agent states and the 9 visual states.
  - `resolver.ts` — `OrchestrationThreadShell → PetContext` (blocking waits
    beat running, review decays after 30 min, archived/snoozed threads are
    excluded).
  - `follow.ts` — multi-agent priority resolution and follow modes
    (selected / highest-priority / recent / pinned / workspace).
  - `bubble.ts` — short human status text, incl. workspace aggregates.
  - `animation.ts` — `AnimationController`: FPS playback, loops, one-shots,
    non-destructive celebrations (jump → review) with a 20 s cooldown,
    same-state debounce.
  - `validator.ts` — deterministic atlas validation (dimensions, alpha,
    populated used cells, transparent unused cells, RGB residue) with an
    injectable pixel source.
  - `renderer.ts` — canvas blitter (`drawImage` of the current frame,
    nearest-neighbor, baseline-anchored).
- `apps/web/src/pets/` — the web surfaces:
  - `petAssets.ts` — built-in pet constants + IndexedDB custom-pet registry +
    `importPetPackage` (validate-then-install).
  - `usePetSnapshot.ts` — derives `PetFollowSelection` + bubble from the
    existing shell atoms + client settings (pure derivation, no new sockets).
  - `PetOverlay.tsx` — the widget (canvas, bubble, drag, click popover,
    context menu, reduced motion, a11y) shared by the in-app and overlay
    surfaces via the `overlay` prop.
  - `PetOverlaySurface.tsx` — the `?surface=pet` boot for the desktop overlay
    window (no router, no Clerk).
- `apps/desktop/src/pet/PetWindow.ts` — the Electron overlay window:
  transparent, frameless, always-on-top, skip-taskbar, never focusable;
  drag deltas from the renderer move the window (clamped to the display work
  area and persisted in `DesktopAppSettings.petWindowPosition`); honors
  click-through / always-on-top / hide-on-fullscreen settings; hides while
  the main window is fullscreen; retries the initial load while the backend
  cold-boots.

## State flow

Settings (`ClientSettings.pets`) are client-local and shared across surfaces
via the existing client-settings persistence. In Electron, the overlay window
shares the default session with the main window, so localStorage settings sync
between them.

## Performance rules

These are enforced by design, not by luck (AGENTS.md: “no continuously
repainting animations”):

- **No new websocket traffic in web.** The pet derives from the shell atoms
  the UI already subscribes to. The desktop overlay adds exactly one small
  renderer; it reuses the existing connection bootstrap.
- **One decoded atlas in memory** (an `ImageBitmap`), blitted with
  `drawImage`; no per-frame decode, no canvas layers per state.
- **Animation loop only while visible.** The `requestAnimationFrame` loop
  starts only when the pet is enabled, visible, and an atlas is loaded, and
  stops when hidden. Idle runs at 10 fps with frame clamping.
- **Reduced motion = zero animation.** One static frame plus the bubble.
- **No LLM calls, ever.** The pet reacts only to read-model state.
- **Event debouncing + celebration cooldown.** Same-state requests are no-ops;
  celebrations are capped (20 s cooldown) so small events never jitter.

## Failure isolation

- A broken custom pet package never installs (validated first) and never
  crashes the app.
- The overlay window creation is forked and best-effort; the pet can fail
  without touching the agent runtime.
- The pet never executes code from a package — `pet.json` + images only
  (spec: “a pet asset is data, not code”).

## Testing

- Unit: resolver, follow/priority, animation controller, bubble, manifest,
  validator (in `packages/pets`).
- Asset QA: `packages/pets/src/defaultAsset.test.ts` validates the committed
  built-in atlas; `node scripts/generate-default-pet.mjs --check` re-validates
  it from disk.

## Deferred (not in V1)

Mobile surface, server-hosted pet registry (pet sync across remote clients),
look-direction V2 atlas, sounds/haptics, personalities/progression, AI pet
generation.
