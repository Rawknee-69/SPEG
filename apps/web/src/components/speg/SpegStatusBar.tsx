/**
 * SPEG status-bar footer (task 1.18).
 *
 * A thin bottom bar in the chat view showing live harness telemetry: the
 * active model, workspace, git branch, prompt-cache hit rates, session/turn
 * token usage, estimated costs, turn count, context-window share,
 * auto-compact threshold, and wallet balance. Each chip is opt-in via the
 * SPEG settings panel (`ClientSettings.speg.statusBar`), and the whole bar
 * can be hidden with the master `enabled` toggle.
 *
 * The bar is deliberately data-driven: it renders whatever the active
 * harness reports through thread activities, so harnesses that don't expose
 * a datum (e.g. a wallet balance for Claude) simply omit that chip.
 */
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { DEFAULT_SPEG_STATUS_BAR_SETTINGS } from "@t3tools/contracts/settings";
import { useMemo } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import {
  STATUS_BAR_ITEM_ORDER,
  deriveStatusBarChips,
  type StatusBarItemId,
} from "./SpegStatusBar.logic";

export interface SpegStatusBarProps {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly model: string | null;
  readonly workspaceRoot: string | null;
  readonly gitBranch: string | null;
  /** Threshold at which the harness auto-compacts; default 80%. */
  readonly compactAtPercent?: number;
}

export function SpegStatusBar(props: SpegStatusBarProps) {
  const statusBar = useClientSettings((settings) => settings.speg?.statusBar);
  const { activities, model, workspaceRoot, gitBranch } = props;

  const settings = statusBar ?? DEFAULT_SPEG_STATUS_BAR_SETTINGS;
  const enabled = settings.enabled !== false;
  const compactAtPercent = props.compactAtPercent ?? 80;

  const visibleItems = useMemo(() => {
    if (!enabled) {
      return null;
    }
    const rawItems = settings.items ?? {};
    const visible = new Set<StatusBarItemId>();
    for (const item of STATUS_BAR_ITEM_ORDER) {
      if (rawItems[item] !== false) {
        visible.add(item);
      }
    }
    return visible;
  }, [enabled, settings.items]);

  const chips = useMemo(() => {
    if (!visibleItems) {
      return [];
    }
    return deriveStatusBarChips({ activities, model, workspaceRoot, gitBranch, compactAtPercent })
      .filter((chip) => visibleItems.has(chip.id))
      .filter((chip) => chip.value !== null);
  }, [visibleItems, activities, model, workspaceRoot, gitBranch, compactAtPercent]);

  if (!enabled || chips.length === 0) {
    return null;
  }

  return (
    <div
      data-speg-status-bar="true"
      className={cn(
        "pointer-events-auto z-10 flex shrink-0 items-center gap-x-4 overflow-x-auto px-4",
        "border-t border-border/60 bg-muted/40 py-1 text-[11px] leading-none text-muted-foreground",
      )}
    >
      {chips.map((chip) => (
        <span
          key={chip.id}
          title={chip.detail ? `${chip.label}: ${chip.detail}` : `${chip.label}: ${chip.value}`}
          className="flex shrink-0 items-baseline gap-1 whitespace-nowrap"
          data-speg-status-bar-item={chip.id}
        >
          <span className="text-muted-foreground/60">{chip.label}</span>
          <span className="font-medium tabular-nums text-muted-foreground">{chip.value}</span>
        </span>
      ))}
    </div>
  );
}
