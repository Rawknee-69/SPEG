import * as NodeTimersPromises from "node:timers/promises";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import type { DesktopPetWindowPosition } from "../settings/DesktopAppSettings.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { getDesktopUrl } from "../electron/ElectronProtocol.ts";

/**
 * Desktop pet overlay window (spec §12, §39-41): a transparent, frameless,
 * always-on-top window that hosts the web app's pet-only surface
 * (`?surface=pet`). The window is moved by drag deltas from the renderer,
 * respects click-through / always-on-top / hide-on-fullscreen settings, stays
 * out of the task switcher, and persists its position.
 */

export const PET_WINDOW_WIDTH = 280;
export const PET_WINDOW_HEIGHT = 320;
export const PET_WINDOW_MARGIN = 24;

export interface PetWindowSettings {
  readonly alwaysOnTop: boolean;
  readonly clickThrough: boolean;
  readonly hideOnFullscreen: boolean;
}

const DEFAULT_PET_WINDOW_SETTINGS: PetWindowSettings = {
  alwaysOnTop: true,
  clickThrough: false,
  hideOnFullscreen: true,
};

export class PetWindow extends Context.Service<
  PetWindow,
  {
    readonly ensureCreated: () => Effect.Effect<void>;
    readonly ensureOpen: () => Effect.Effect<void>;
    readonly hide: () => Effect.Effect<void>;
    readonly show: () => Effect.Effect<void>;
    readonly dragBy: (dx: number, dy: number) => Effect.Effect<void>;
    readonly applyWindowSettings: (settings: PetWindowSettings) => Effect.Effect<void>;
  }
>()("@speg/desktop/pet/PetWindow") {}

function defaultPosition(): DesktopPetWindowPosition {
  const display = Electron.screen.getPrimaryDisplay();
  const area = display.workArea;
  return {
    x: area.x + area.width - PET_WINDOW_WIDTH - PET_WINDOW_MARGIN,
    y: area.y + area.height - PET_WINDOW_HEIGHT - PET_WINDOW_MARGIN,
  };
}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const windowRef = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
  const windowSettingsRef = yield* Ref.make<PetWindowSettings>(DEFAULT_PET_WINDOW_SETTINGS);

  const liveWindow = Effect.gen(function* () {
    const current = yield* Ref.get(windowRef);
    if (Option.isSome(current) && !current.value.isDestroyed()) {
      return current;
    }
    return Option.none<Electron.BrowserWindow>();
  });

  const hideWindow = Effect.fn("desktop.pet.hideWindow")(function* () {
    const current = yield* liveWindow;
    if (Option.isSome(current)) {
      yield* Effect.sync(() => current.value.hide());
    }
  });

  const showWindow = Effect.fn("desktop.pet.showWindow")(function* () {
    const current = yield* liveWindow;
    if (Option.isSome(current)) {
      yield* Effect.sync(() => current.value.showInactive());
    }
  });

  const createWindow = Effect.fn("desktop.pet.createWindow")(function* () {
    const settings = yield* desktopSettings.get;
    const position = settings.petWindowPosition ?? defaultPosition();
    const window = yield* electronWindow.create({
      x: position.x,
      y: position.y,
      width: PET_WINDOW_WIDTH,
      height: PET_WINDOW_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      fullscreenable: false,
      backgroundColor: "#00000000",
      webPreferences: {
        preload: environment.preloadPath,
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
      },
    });

    yield* Effect.sync(() => window.setMenu(null));
    yield* Ref.set(windowRef, Option.some(window));

    // Hide when the main window enters fullscreen, per the user setting.
    const mainWindow = yield* electronWindow.currentMainOrFirst;
    if (Option.isSome(mainWindow)) {
      mainWindow.value.on("enter-full-screen", () => {
        void Effect.runPromise(
          Effect.gen(function* () {
            const petSettings = yield* Ref.get(windowSettingsRef);
            if (petSettings.hideOnFullscreen) {
              yield* hideWindow();
            }
          }),
        );
      });
      mainWindow.value.on("leave-full-screen", () => {
        void Effect.runPromise(showWindow());
      });
    }

    // Load the pet-only surface of the web app.
    const applicationUrl = new URL(getDesktopUrl(environment.isDevelopment));
    applicationUrl.searchParams.set("surface", "pet");
    // The backend may still be cold-booting when the window is created; retry
    // the load until it lands so the overlay eventually appears.
    let retryCount = 0;
    window.webContents.on("did-fail-load", () => {
      if (retryCount >= 10) return;
      retryCount += 1;
      void (async () => {
        await NodeTimersPromises.setTimeout(2_000);
        if (!window.isDestroyed()) {
          window.loadURL(applicationUrl.toString()).catch(() => undefined);
        }
      })();
    });
    window.loadURL(applicationUrl.toString()).catch(() => undefined);

    return window;
  });

  const clampToDisplay = (x: number, y: number): DesktopPetWindowPosition => {
    const display = Electron.screen.getDisplayMatching({
      x,
      y,
      width: PET_WINDOW_WIDTH,
      height: PET_WINDOW_HEIGHT,
    });
    const area = display.workArea;
    return {
      x: Math.max(area.x, Math.min(x, area.x + area.width - PET_WINDOW_WIDTH)),
      y: Math.max(area.y, Math.min(y, area.y + area.height - PET_WINDOW_HEIGHT)),
    };
  };

  return PetWindow.of({
    ensureCreated: Effect.fn("desktop.pet.ensureCreated")(function* () {
      const existing = yield* liveWindow;
      if (Option.isNone(existing)) {
        yield* createWindow().pipe(Effect.catch(() => Effect.void));
      }
    }),
    ensureOpen: Effect.fn("desktop.pet.ensureOpen")(function* () {
      const existing = yield* liveWindow;
      if (Option.isNone(existing)) {
        yield* createWindow().pipe(Effect.catch(() => Effect.void));
      }
      yield* showWindow();
    }),
    hide: Effect.fn("desktop.pet.hide")(function* () {
      yield* hideWindow();
    }),
    show: Effect.fn("desktop.pet.show")(function* () {
      yield* showWindow();
    }),
    dragBy: Effect.fn("desktop.pet.dragBy")(function* (dx: number, dy: number) {
      const current = yield* liveWindow;
      if (Option.isNone(current)) {
        return;
      }
      const window = current.value;
      const position = yield* Effect.sync(() => window.getPosition());
      const x = position[0] ?? 0;
      const y = position[1] ?? 0;
      const clamped = clampToDisplay(x + dx, y + dy);
      yield* Effect.sync(() => window.setPosition(clamped.x, clamped.y));
      yield* desktopSettings.setPetWindowPosition(clamped).pipe(Effect.catch(() => Effect.void));
    }),
    applyWindowSettings: Effect.fn("desktop.pet.applyWindowSettings")(function* (
      settings: PetWindowSettings,
    ) {
      yield* Ref.set(windowSettingsRef, settings);
      const current = yield* liveWindow;
      if (Option.isNone(current)) {
        return;
      }
      const window = current.value;
      yield* Effect.sync(() => window.setAlwaysOnTop(settings.alwaysOnTop));
      yield* Effect.sync(() =>
        window.setIgnoreMouseEvents(settings.clickThrough, { forward: true }),
      );
    }),
  });
});

export const layer = Layer.effect(PetWindow, make);
