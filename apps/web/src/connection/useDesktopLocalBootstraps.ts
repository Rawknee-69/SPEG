import type { DesktopEnvironmentBootstrap } from "@speg/contracts";
import { useEffect, useState } from "react";

import { isElectron } from "../env";
import { readDesktopSecondaryBootstraps } from "./desktopLocal";

const DESKTOP_LOCAL_BOOTSTRAP_POLL_MS = 2_000;

/**
 * Reactively track the desktop's secondary local backends (e.g. a parallel WSL
 * backend). The bridge exposes no change event, so we re-read on an interval;
 * failed reads retain the latest successful snapshot, while a successful empty
 * read clears it. Use this instead of polling the bridge ad hoc so every
 * renderer consumer reads the same topology.
 *
 * The interval only runs in the Electron shell, and re-renders only when the
 * topology actually changes (the reader returns a fresh array identity on
 * every call, so a naive setState would re-render consumers every 2s).
 */
export function useDesktopLocalBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  const [bootstraps, setBootstraps] = useState<ReadonlyArray<DesktopEnvironmentBootstrap>>(
    readDesktopSecondaryBootstraps,
  );

  useEffect(() => {
    if (!isElectron) {
      return;
    }
    const read = () => {
      const next = readDesktopSecondaryBootstraps();
      setBootstraps((previous) => (sameBootstraps(previous, next) ? previous : next));
    };
    read();
    const interval = setInterval(read, DESKTOP_LOCAL_BOOTSTRAP_POLL_MS);
    return () => clearInterval(interval);
  }, []);

  return bootstraps;
}

function sameBootstraps(
  a: ReadonlyArray<DesktopEnvironmentBootstrap>,
  b: ReadonlyArray<DesktopEnvironmentBootstrap>,
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]!.id !== b[i]!.id) {
      return false;
    }
  }
  return true;
}
