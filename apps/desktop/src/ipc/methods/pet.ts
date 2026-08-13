import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as PetWindow from "../../pet/PetWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const PetDragDelta = Schema.Struct({
  dx: Schema.Number,
  dy: Schema.Number,
});

const PetWindowSettings = Schema.Struct({
  alwaysOnTop: Schema.Boolean,
  clickThrough: Schema.Boolean,
  hideOnFullscreen: Schema.Boolean,
});

export const petEnsure = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PET_ENSURE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.pet.ensure")(function* () {
    const petWindow = yield* PetWindow.PetWindow;
    yield* petWindow.ensureOpen();
  }),
});

export const petHide = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PET_HIDE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.pet.hide")(function* () {
    const petWindow = yield* PetWindow.PetWindow;
    yield* petWindow.hide();
  }),
});

export const petDrag = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PET_DRAG_CHANNEL,
  payload: PetDragDelta,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.pet.drag")(function* (delta) {
    const petWindow = yield* PetWindow.PetWindow;
    yield* petWindow.dragBy(delta.dx, delta.dy);
  }),
});

export const petSetSettings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PET_SET_SETTINGS_CHANNEL,
  payload: PetWindowSettings,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.pet.setSettings")(function* (settings) {
    const petWindow = yield* PetWindow.PetWindow;
    yield* petWindow.applyWindowSettings(settings);
  }),
});

export const installPetIpcHandlers = Effect.fn("desktop.ipc.installPetHandlers")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  yield* ipc.handle(petEnsure);
  yield* ipc.handle(petHide);
  yield* ipc.handle(petDrag);
  yield* ipc.handle(petSetSettings);
});
