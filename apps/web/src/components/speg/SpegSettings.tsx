/**
 * SPEG settings panel (task 1.12).
 *
 * A settings section for the SPEG integration: jcode binary/build config,
 * the local cacm-daemon (host/port, auto-start, watch paths, storage
 * backend), context injection preferences, per-agent watching toggles, and
 * Phase-3 skill toggles. All values live in the client-local `speg` blob
 * (`ClientSettings.speg`, persisted to localStorage), so every edit commits
 * immediately through `useUpdateClientSettings` — there is no save button,
 * matching the rest of the settings UI.
 */
import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_SPEG_CACM_PORT,
  type SpegContextInjectionMode,
  type SpegJcodeBinaryPathMode,
  type SpegSettings,
  type SpegStorageBackend,
} from "@t3tools/contracts/settings";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { searchableSetting } from "../settings/settingsSearch";
import {
  AGENT_WATCH_LABELS,
  WATCH_AGENT_ORDER,
  parsePort,
  parseTokenBudget,
  parseWatchPathList,
  watchPathListToText,
} from "./SpegSettings.logic";

const CONTEXT_INJECTION_LABELS: Readonly<Record<SpegContextInjectionMode, string>> = {
  auto: "Auto",
  manual: "Manual",
  off: "Off",
};

const STORAGE_BACKEND_LABELS: Readonly<Record<SpegStorageBackend, string>> = {
  sqlite: "SQLite",
  sled: "Sled",
  memory: "In-memory",
};

/**
 * Text field that keeps a local draft and only commits on blur (or Enter),
 * so intermediate keystrokes never spam the persisted settings blob.
 * Exported for unit tests.
 */
export function DraftTextInput({
  value,
  onCommit,
  ariaLabel,
  placeholder,
  className,
}: {
  value: string;
  onCommit: (next: string) => void;
  ariaLabel: string;
  placeholder?: string;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  return (
    <Input
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const next = draft.trim();
        if (next !== value) onCommit(next);
        setDraft(value);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
      aria-label={ariaLabel}
      placeholder={placeholder}
      className={className}
    />
  );
}

/**
 * Number field that commits whenever the text parses to a valid value
 * (mirrors the auto-settle days input in Settings → Beta), and snaps back to
 * the persisted value on blur. Exported for unit tests.
 */
export function DraftNumberInput({
  value,
  onCommit,
  parse,
  ariaLabel,
  className,
}: {
  value: number;
  onCommit: (next: number) => void;
  parse: (text: string) => number | null;
  ariaLabel: string;
  className?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  return (
    <Input
      type="number"
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        const parsed = parse(event.target.value);
        if (parsed !== null && parsed !== value) onCommit(parsed);
      }}
      onBlur={() => {
        const parsed = parse(draft);
        if (parsed !== null && parsed !== value) onCommit(parsed);
        setDraft(String(value));
      }}
      aria-label={ariaLabel}
      className={className}
    />
  );
}

/** Watch-path editor: one path per line, committed on blur. Exported for unit tests. */
export function WatchPathsEditor({
  value,
  onCommit,
  ariaLabel,
}: {
  value: readonly string[];
  onCommit: (next: string[]) => void;
  ariaLabel: string;
}) {
  const [draft, setDraft] = useState(() => watchPathListToText(value));
  useEffect(() => setDraft(watchPathListToText(value)), [value]);

  return (
    <Textarea
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const parsed = parseWatchPathList(draft);
        if (watchPathListToText(parsed) !== watchPathListToText(value)) onCommit(parsed);
        setDraft(watchPathListToText(value));
      }}
      aria-label={ariaLabel}
      placeholder={"/path/to/agent/sessions\n/path/to/another"}
      className="min-h-17.5 w-full sm:min-w-72"
    />
  );
}

export function SpegSettings() {
  const speg = useClientSettings((settings) => settings.speg);
  const updateSettings = useUpdateClientSettings();

  const updateSpeg = useCallback(
    (patch: Partial<SpegSettings>) => {
      updateSettings({ speg: { ...speg, ...patch } });
    },
    [speg, updateSettings],
  );

  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("speg-jcode")}>
        <SettingsRow
          title="Binary path mode"
          description="Auto-detect resolves the jcode binary from PATH (falling back to the binary bundled with jcode-sdk). Manual lets you point at a specific build."
          control={
            <Select
              value={speg.jcodeBinaryPathMode}
              onValueChange={(value) =>
                updateSpeg({ jcodeBinaryPathMode: value as SpegJcodeBinaryPathMode })
              }
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Jcode binary path mode">
                <SelectValue>
                  {speg.jcodeBinaryPathMode === "manual" ? "Manual" : "Auto-detect"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="auto">
                  Auto-detect
                </SelectItem>
                <SelectItem hideIndicator value="manual">
                  Manual
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        {speg.jcodeBinaryPathMode === "manual" ? (
          <SettingsRow
            title="Binary path"
            description="Absolute path to the jcode binary to launch."
            control={
              <DraftTextInput
                value={speg.jcodeBinaryPath}
                onCommit={(next) => updateSpeg({ jcodeBinaryPath: next })}
                ariaLabel="Jcode binary path"
                placeholder="/path/to/jcode"
                className="w-full sm:w-64"
              />
            }
          />
        ) : null}
        <SettingsRow
          title="Build command"
          description="Optional shell command SPEG runs to build jcode from source when the daemon binary is missing. Empty means never build."
          control={
            <DraftTextInput
              value={speg.jcodeBuildCommand}
              onCommit={(next) => updateSpeg({ jcodeBuildCommand: next })}
              ariaLabel="Jcode build command"
              placeholder="cargo build --release"
              className="w-full sm:w-64"
            />
          }
        />
        <SettingsRow
          title="Launch arguments"
          description="Extra CLI arguments passed to the jcode daemon on start."
          control={
            <DraftTextInput
              value={speg.jcodeLaunchArgs}
              onCommit={(next) => updateSpeg({ jcodeLaunchArgs: next })}
              ariaLabel="Jcode launch arguments"
              placeholder="--api-socket /tmp/jcode.sock"
              className="w-full sm:w-64"
            />
          }
        />
      </SettingsSection>

      <SettingsSection {...searchableSetting("speg-cacm")}>
        <SettingsRow
          title="Daemon address"
          description={`Host and port the cacm-daemon listens on (WebSocket). Defaults to localhost:${DEFAULT_SPEG_CACM_PORT}.`}
          control={
            <div className="flex items-center gap-2">
              <DraftTextInput
                value={speg.cacmHost}
                onCommit={(next) => updateSpeg({ cacmHost: next })}
                ariaLabel="CACM daemon host"
                placeholder="localhost"
                className="w-full sm:w-40"
              />
              <DraftNumberInput
                value={speg.cacmPort}
                onCommit={(next) => updateSpeg({ cacmPort: next })}
                parse={parsePort}
                ariaLabel="CACM daemon port"
                className="w-full sm:w-28"
              />
            </div>
          }
        />
        <SettingsRow
          title="Auto-start daemon"
          description="Launch the cacm-daemon automatically when the app starts. Turn off to manage it yourself."
          control={
            <Switch
              checked={speg.cacmAutoStart}
              onCheckedChange={(checked) => updateSpeg({ cacmAutoStart: Boolean(checked) })}
              aria-label="Auto-start CACM daemon"
            />
          }
        />
        <SettingsRow
          title="Storage backend"
          description="Where the daemon persists cross-agent context. SQLite is the default; Sled is a fast embedded store; In-memory does not survive restarts."
          control={
            <Select
              value={speg.cacmStorageBackend}
              onValueChange={(value) =>
                updateSpeg({ cacmStorageBackend: value as SpegStorageBackend })
              }
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="CACM storage backend">
                <SelectValue>{STORAGE_BACKEND_LABELS[speg.cacmStorageBackend]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="sqlite">
                  SQLite
                </SelectItem>
                <SelectItem hideIndicator value="sled">
                  Sled
                </SelectItem>
                <SelectItem hideIndicator value="memory">
                  In-memory
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Watch paths"
          description="Agent session directories the daemon watches, one per line. Leave empty to watch each agent's default location."
          control={
            <WatchPathsEditor
              value={speg.cacmWatchPaths}
              onCommit={(next) => updateSpeg({ cacmWatchPaths: next })}
              ariaLabel="CACM watch paths"
            />
          }
        />
      </SettingsSection>

      <SettingsSection {...searchableSetting("speg-context-injection")}>
        <SettingsRow
          title="Injection mode"
          description="Auto injects cross-agent context into every turn. Manual shows an inject button for you to review first. Off disables injection."
          control={
            <Select
              value={speg.contextInjectionMode}
              onValueChange={(value) =>
                updateSpeg({ contextInjectionMode: value as SpegContextInjectionMode })
              }
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Context injection mode">
                <SelectValue>{CONTEXT_INJECTION_LABELS[speg.contextInjectionMode]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="auto">
                  Auto
                </SelectItem>
                <SelectItem hideIndicator value="manual">
                  Manual
                </SelectItem>
                <SelectItem hideIndicator value="off">
                  Off
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Max context budget"
          description="Maximum tokens of cross-agent context injected into a thread per turn."
          control={
            <DraftNumberInput
              value={speg.maxContextBudgetTokens}
              onCommit={(next) => updateSpeg({ maxContextBudgetTokens: next })}
              parse={parseTokenBudget}
              ariaLabel="Max context budget in tokens"
              className="w-full sm:w-32"
            />
          }
        />
      </SettingsSection>

      <SettingsSection {...searchableSetting("speg-agent-watching")}>
        {WATCH_AGENT_ORDER.map((agent) => (
          <SettingsRow
            key={agent}
            title={AGENT_WATCH_LABELS[agent]}
            description="Watch this agent's sessions and extract cross-agent context from them."
            control={
              <Switch
                checked={speg.watchedAgents[agent] ?? true}
                onCheckedChange={(checked) =>
                  updateSpeg({
                    watchedAgents: { ...speg.watchedAgents, [agent]: Boolean(checked) },
                  })
                }
                aria-label={`Watch ${AGENT_WATCH_LABELS[agent]} sessions`}
              />
            }
          />
        ))}
      </SettingsSection>

      <SettingsSection {...searchableSetting("speg-skills")}>
        {Object.keys(speg.skillToggles).length === 0 ? (
          <SettingsRow
            title="Skills"
            description="Per-skill toggles land with the Phase 3 skill manager. No skills are registered yet."
          />
        ) : (
          Object.entries(speg.skillToggles).map(([skill, enabled]) => (
            <SettingsRow
              key={skill}
              title={skill}
              description="Enable this skill for SPEG-managed turns."
              control={
                <Switch
                  checked={enabled}
                  onCheckedChange={(checked) =>
                    updateSpeg({
                      skillToggles: { ...speg.skillToggles, [skill]: Boolean(checked) },
                    })
                  }
                  aria-label={`Enable ${skill} skill`}
                />
              }
            />
          ))
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
