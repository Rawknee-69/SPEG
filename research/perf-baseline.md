# SPEG — Performance Baseline (pre-optimization)

> Generated: 2026-08-11 | Workspace: `E:\SPEG\t3code` (commit `367cf470`)
> Purpose: before/after numbers for the 2026-08 performance pass. Re-measure after
> each phase and record deltas here. Measured facts are cited; estimates are marked ~.

## 1. Bundle / boot (from `apps/web/dist`, built 2026-08-12)

| Asset                          | Size (raw)                     | Notes                                                                          |
| ------------------------------ | ------------------------------ | ------------------------------------------------------------------------------ |
| `index-*.js` (entry)           | **3,692,650 B** (~1.2 MB gzip) | all 17 routes + Clerk + @pierre/diffs + Lexical + Electron preview hosts eager |
| `utils-*.js`                   | 664,908 B                      | modulepreload                                                                  |
| `textarea-*.js`                | 290,271 B                      | modulepreload                                                                  |
| `index-*.css`                  | 406,755 B                      | render-blocking Tailwind v4                                                    |
| `worker-*.js`                  | 833,722 B                      | @pierre/diffs worker                                                           |
| `ghostty-vt-*.wasm`            | 630,932 B                      | terminal                                                                       |
| `SymbolsNerdFontMono-*.woff2`  | 1,177,576 B                    | terminal font (lazy)                                                           |
| `emacs-lisp-*.js` / `cpp-*.js` | 779,921 / 626,168 B            | shiki grammars (lazy)                                                          |
| Total `dist/`                  | 58 MB                          | incl. sourcemaps                                                               |

- Initial JS ≈ 4.65 MB raw (~1.6 MB gzip) + 407 KB CSS before any lazy chunk.
- **No route-level code splitting** (`routeTree.gen.ts` statically imports all routes).
- Auth gate `beforeLoad` awaits `fetchSessionState()` with **no fetch timeout** (up to 15 s transient retry; indefinite if the connection hangs) — nothing renders until it resolves.

## 2. Idle GPU / compositor (steady state, video wallpaper active)

- Full-screen `<video>` wallpaper (blob up to 80 MB) + **5 persistent `backdrop-filter: blur()` surfaces** re-sampling it every frame:
  sidebar `--glass-blur-regular` 24 px, topbar 18 px, composer shell 12 px, status bar 18 px, right-panel tabbar 24 px, plus a **redundant 2nd composer pill blur** (`.chat-composer-glass` inside the already-blurred shell).
- Electron: `backgroundThrottling: false` + hardware acceleration ON → renderer stays full-budget when minimized/occluded.
- GlassPointerLight rAF loop: while pointer is over `[data-glass-light]`, per-frame `querySelectorAll` + `getBoundingClientRect()` (layout read) + 3 CSS-var writes per surface → forced style recalc + full-width/height gradient repaint each frame.

## 3. Idle CPU timers (web renderer)

| Timer                                                           | Interval | Runs at idle?                                                              |
| --------------------------------------------------------------- | -------- | -------------------------------------------------------------------------- |
| OTLP exporter flush (`clientTracing.ts`)                        | 1 s      | Yes (fiber wakes every 1 s; POSTs while spans buffered)                    |
| `useDesktopLocalBootstraps` (`useDesktopLocalBootstraps.ts:23`) | 2 s      | Yes — guaranteed fresh `[]` → React re-render every 2 s, even non-Electron |
| Platform registration poll (`connection/platform.ts`)           | 3 s      | Desktop                                                                    |
| `backgroundActivityReporter`                                    | 25 s     | Yes (RPC)                                                                  |
| `useRelativeTimeTick` rows (`settingsLayout.tsx`)               | 1 s      | Only while settings pages open (N rows = N intervals)                      |
| Working timers (AgentsPanel / MessagesTimeline / SidebarV2)     | 1 s      | Only while agents working (DOM-write, no React commit)                     |

## 4. Streaming render cost (per agent event)

- `ChatView`/`ChatViewContent` not memoized; every WS event re-renders the whole ~5300-line body.
- `derive*` (`session-logic.ts`) each do `[...activities].toSorted(...)` = **O(n log n) copy-sort per event**, keyed by array identity → re-run on every event.
- `agentPanelModel` in `TimelineRowSharedState` → **every visible timeline row re-renders per event** (memo boundary defeated via context).
- `ChatMarkdown` shiki cache disabled while streaming → long code blocks re-highlighted on every delta.
- `SpegStatusBar`/`ComposerBannerStack` not memoized; fresh array props per event.
- Client reducer `threadReducer.ts:549-579`: `activity-appended` = O(n) filter + O(n log n) sort per event.

## 5. Desktop / server steady state

- resource-monitor (Rust sidecar, `native/resource-monitor`): samples **all processes** every 1 s (AC) / 5 s (battery) / 15 s (constrained) **even with zero subscribers** (`NativeTelemetryClient.ts:255-272`).
- `cacm-daemon` sidecar auto-starts at server startup (if binary present).
- Server timers: analytics flush 1 s (no-op when empty), terminal subprocess poll 1 s, preview port scan 3 s, background-policy lease broadcast 15 s, VCS git fetch per-subscriber 30 s (lease-gated).

## 6. RAM

- `previewStateAtom` = `Atom.keepAlive` → every thread that ever opened a preview pins memory for app lifetime (`removePreviewThread` never called).
- `uiStateStore` `threadLastVisitedAtById`/`threadChangedFilesExpandedById` grow without bound; fully JSON-serialized to localStorage on every boot and debounced (500 ms) on change.
- IDB thread store has no per-environment LRU cap.
- Wallpaper IDB: single blob, deleted on replace/remove, object URLs revoked — verified clean.
- resource-monitor history bounded (3600 snapshots / 64 MB); analytics buffer bounded (1000 events).

## 7. Measurement method (how to re-verify)

- Idle CPU/GPU: open web app (Chrome) and desktop (Electron) with a video wallpaper; let settle 60 s; read Task Manager (GPU process, renderer process) + Chrome Task Manager (`chrome://process-internals`/`taskmanager`) CPU/RAM columns.
- Boot: DevTools Performance "record reload" → time to `first contentful paint` + `load`; measure entry chunk via Network panel.
- Streaming: start a turn, sample renderer CPU over 30 s; React Profiler for re-render count per event.
- After each phase, append the delta to the matching section above.

---

## Phase 4 delta (2026-08-11, entry after route-level code splitting)

Rebuilt `apps/web` with `autoCodeSplitting: true` (root + `/_chat` shell kept eager):

| Asset                      | Before                    | After                         | Δ                  |
| -------------------------- | ------------------------- | ----------------------------- | ------------------ |
| `index-*.js` (entry)       | 3,692,650 B (1.2 MB gzip) | **1,583,070 B (502 KB gzip)** | **−57%**           |
| ChatView route chunk       | — (in entry)              | 1,003,400 B (297 KB gzip)     | lazy               |
| ComposerPromptEditor chunk | —                         | 408,590 B                     | lazy               |
| FilePreviewPanel chunk     | 386,930 B                 | 386,930 B                     | unchanged          |
| `runtime-*.js`             | —                         | 240,040 B                     | new shared runtime |

## Phase 3 delta (2026-08-11)

- `useDesktopLocalBootstraps`: interval only on Electron; re-renders only when topology ids change (was: every 2 s on every platform).
- OTLP exporter: default flush interval 1 s → 10 s + `maxBatchSize: 50` (active bursts still flush immediately; idle fiber wakes 10× less often).
- Platform registration poll: 3 s → 15 s.
- `useRelativeTimeTick`: pauses while the tab is hidden.
- Streaming: `agentPanelModel` moved out of the shared timeline context into a narrow context (only the agent-CTA row consumes it) → activity events no longer re-render every visible row; `SpegStatusBar` + `ComposerBannerStack` are now `memo`'d; shiki highlight cache re-enabled while streaming; `threadReducer` activity-appended is now a binary-search insert (O(log n)) instead of filter + sort (O(n log n)).
- DevTools-lag: pointer-light writes throttled to ~30 Hz + light layer promoted (`will-change: opacity`); redundant composer-pill `backdrop-filter` removed; `console.warn` in hot/recurring paths gated to `import.meta.env.DEV`; auth-gate `fetchSessionState` bounded by a 5 s timeout.

## Phase 2 delta (2026-08-11)

- Video wallpaper: FPS slider (24 → monitor Hz, >60 shows a high-GPU warning, video-only) driving a resolution-capped canvas sampler; native video path when fps ≥ monitor Hz; video pauses on window blur (Electron); glass blur radii trimmed ~⅓ while `html[data-wallpaper="video"]`; upload-time normalization (fast path for ≤1920 px / ≤60 fps / ≤20 MB, real-time MediaRecorder transcode otherwise, always falls back to the original on failure).
