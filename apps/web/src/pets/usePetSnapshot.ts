import { useMemo } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { PetFollowMode, PetSettings, OrchestrationThreadShell } from "@speg/contracts";
import {
  isThreadEligibleForFollow,
  resolveFollow,
  resolvePetContext,
  resolveStatusBubble,
  type PetFollowSelection,
} from "@speg/pets";
import { Atom } from "effect/unstable/reactivity";

import { useClientSettings } from "~/hooks/useSettings";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { environmentThreadShells } from "~/state/threads";
import { useThreadSelectionStore } from "~/threadSelectionStore";

const EMPTY_THREADS: ReadonlyArray<OrchestrationThreadShell> = Object.freeze([]);
const EMPTY_THREADS_ATOM = Atom.make(EMPTY_THREADS).pipe(Atom.withLabel("web-pet-threads:empty"));

export interface PetSnapshot {
  readonly settings: PetSettings;
  readonly selection: PetFollowSelection;
  readonly bubble: string | null;
}

function firstSelectedThreadId(selectedKeys: ReadonlySet<string>): string | null {
  for (const key of selectedKeys) {
    const separator = key.indexOf("\u0000");
    if (separator >= 0) {
      return key.slice(separator + 1);
    }
  }
  return null;
}

/**
 * Derives the pet's normalized context from the same read model the UI renders
 * (shell snapshot atoms + client settings). Pure derivation — no new sockets,
 * no per-provider code: every provider is already normalized into
 * `OrchestrationThreadShell` by the server.
 */
export function usePetSnapshot(now: number): PetSnapshot {
  const environmentId = usePrimaryEnvironmentId();
  const threads = useAtomValue(
    environmentId === null
      ? EMPTY_THREADS_ATOM
      : environmentThreadShells.environmentThreadsAtom(environmentId),
  );
  const settings = useClientSettings((client) => client.pets);
  const selectedThreadKeys = useThreadSelectionStore((state) => state.selectedThreadKeys);

  return useMemo(() => {
    const snapshots = threads
      .filter((thread) => isThreadEligibleForFollow(thread, now))
      .map((thread) => ({
        threadId: thread.id,
        updatedAt: Date.parse(thread.updatedAt) || 0,
        context: resolvePetContext(thread, now),
      }));

    const selection = resolveFollow(snapshots, {
      mode: settings.followMode as PetFollowMode,
      selectedThreadId: firstSelectedThreadId(selectedThreadKeys),
      pinnedThreadId: null,
    });
    const bubble = resolveStatusBubble(selection.context, {
      mode: selection.mode,
      workspace: selection.workspace,
    });
    return { settings, selection, bubble };
  }, [now, settings, selectedThreadKeys, threads]);
}
