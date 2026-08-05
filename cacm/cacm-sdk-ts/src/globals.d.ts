// Minimal ambient declarations for the timer globals the client uses, so the
// published src build does not depend on DOM or @types/node typings. The
// client runs in browsers and in Node >= 22; both provide setTimeout/clearTimeout
// with an opaque handle that we only ever pass back to clearTimeout.
declare function setTimeout(handler: () => void, timeout?: number, ...args: unknown[]): number;
declare function clearTimeout(handle: number): void;
