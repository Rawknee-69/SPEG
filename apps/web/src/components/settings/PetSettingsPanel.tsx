import { useEffect, useMemo, useRef, useState } from "react";
import { type PetFollowMode, type PetScale, type PetSettings } from "@speg/contracts";
import { renderSize, SpriteRenderer } from "@speg/pets";
import { PawPrintIcon, UploadIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import {
  DEFAULT_PET_ASSET_URL,
  DEFAULT_PET_ID,
  deleteInstalledPet,
  importPetPackage,
  listInstalledPets,
  type InstalledPet,
} from "~/pets/petAssets";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const PET_ANCHORS: ReadonlyArray<PetSettings["anchor"]> = [
  "top-left",
  "top-center",
  "top-right",
  "center-left",
  "center",
  "center-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];

const PET_FOLLOW_MODES: ReadonlyArray<{ value: PetFollowMode; label: string }> = [
  { value: "highest-priority", label: "Highest priority" },
  { value: "selected", label: "Selected task" },
  { value: "recent", label: "Most recent" },
  { value: "pinned", label: "Pinned task" },
  { value: "workspace", label: "Whole workspace" },
];

const PET_SCALES: ReadonlyArray<{ value: PetScale; label: string }> = [
  { value: 0.75, label: "Small" },
  { value: 1, label: "Normal" },
  { value: 1.5, label: "Large" },
];

export function PetSettingsPanel() {
  const settings = useClientSettings((client) => client.pets);
  const update = useUpdateClientSettings();
  const patch = (partial: Partial<PetSettings>) => update({ pets: { ...settings, ...partial } });

  const [installed, setInstalled] = useState<ReadonlyArray<InstalledPet>>([]);
  const [manifestText, setManifestText] = useState("");
  const [spritesheetFile, setSpritesheetFile] = useState<File | null>(null);
  const [importIssues, setImportIssues] = useState<readonly string[]>([]);
  const [importing, setImporting] = useState(false);
  const manifestInputRef = useRef<HTMLInputElement>(null);
  const spritesheetInputRef = useRef<HTMLInputElement>(null);

  const reload = () => {
    void listInstalledPets().then(setInstalled);
  };
  useEffect(reload, []);

  const selectedPet = useMemo(
    () =>
      installed.find((pet) => pet.id === settings.selectedPet) ??
      (settings.selectedPet === DEFAULT_PET_ID ? "built-in" : null),
    [installed, settings.selectedPet],
  );

  const petOptions = useMemo(() => {
    const options: Array<{ value: string; label: string }> = [
      { value: DEFAULT_PET_ID, label: "Spark (built-in)" },
    ];
    for (const pet of installed) {
      options.push({ value: pet.id, label: pet.displayName });
    }
    return options;
  }, [installed]);

  const handleImport = async () => {
    if (manifestText.trim().length === 0 || spritesheetFile === null) return;
    setImporting(true);
    setImportIssues([]);
    try {
      const result = await importPetPackage({
        manifestJson: manifestText,
        spritesheet: spritesheetFile,
      });
      if (result.ok && result.pet !== undefined) {
        setManifestText("");
        setSpritesheetFile(null);
        reload();
        patch({ selectedPet: result.pet.id });
      } else {
        setImportIssues(result.issues ?? ["Import failed."]);
      }
    } finally {
      setImporting(false);
    }
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        {...searchableSetting("pet")}
        title="Pet"
        icon={<PawPrintIcon className="size-4" />}
      >
        <SettingsRow
          title="Enable pet"
          description="Show the companion that reflects your agents' state."
          control={
            <Switch
              checked={settings.enabled}
              onCheckedChange={(checked) => patch({ enabled: checked })}
              aria-label="Enable pet"
            />
          }
        />
        <SettingsRow
          title="Show pet"
          description="Temporarily hide the pet without disabling it."
          control={
            <Switch
              checked={settings.visible}
              onCheckedChange={(checked) => patch({ visible: checked })}
              aria-label="Show pet"
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        {...searchableSetting("pet-selection")}
        title="Pet selection"
        icon={<PawPrintIcon className="size-4" />}
      >
        <SettingsRow
          title="Selected pet"
          description="Custom pets are validated before they become selectable."
          control={
            <Select
              value={settings.selectedPet}
              onValueChange={(value) => patch({ selectedPet: value ?? DEFAULT_PET_ID })}
              items={petOptions}
            >
              <SelectTrigger className="w-48" aria-label="Selected pet">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {petOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        >
          <div className="flex items-center gap-3 rounded-lg bg-sidebar-row-hover/50 p-3">
            <PetPreview petId={settings.selectedPet} installedPets={installed} scale={1} />
            <div className="min-w-0 text-xs text-muted-foreground">
              <p className="truncate font-medium text-foreground">
                {typeof selectedPet === "string"
                  ? "Spark"
                  : (selectedPet?.displayName ?? "Unknown pet")}
              </p>
              <p className="line-clamp-2">
                {typeof selectedPet === "string"
                  ? "The built-in SPEG companion."
                  : (selectedPet?.description ?? "Not installed.")}
              </p>
            </div>
          </div>
          {installed.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {installed.map((pet) => (
                <Button
                  key={pet.id}
                  size="xs"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => {
                    void deleteInstalledPet(pet.id).then(() => {
                      if (settings.selectedPet === pet.id) patch({ selectedPet: DEFAULT_PET_ID });
                      reload();
                    });
                  }}
                >
                  Remove {pet.displayName}
                </Button>
              ))}
            </div>
          ) : null}
        </SettingsRow>

        <SettingsRow
          title="Import custom pet"
          description="Pick pet.json and a matching 1536x1872 spritesheet. Invalid packages are rejected with the reason shown below."
        >
          <div className="space-y-2 pt-2">
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={manifestInputRef}
                accept=".json,application/json"
                className="sr-only"
                type="file"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file === undefined) return;
                  void file.text().then(setManifestText);
                }}
              />
              <Button size="sm" variant="outline" onClick={() => manifestInputRef.current?.click()}>
                <UploadIcon />
                {manifestText.trim().length > 0 ? "pet.json loaded" : "Choose pet.json"}
              </Button>
              <input
                ref={spritesheetInputRef}
                accept="image/webp,image/png"
                className="sr-only"
                type="file"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file !== undefined) setSpritesheetFile(file);
                }}
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => spritesheetInputRef.current?.click()}
              >
                <UploadIcon />
                {spritesheetFile !== null ? "Spritesheet loaded" : "Choose spritesheet"}
              </Button>
              <Button
                size="sm"
                disabled={importing || manifestText.trim().length === 0 || spritesheetFile === null}
                onClick={() => void handleImport()}
              >
                {importing ? "Validating…" : "Import"}
              </Button>
            </div>
            {importIssues.length > 0 ? (
              <ul className="space-y-1 rounded-lg bg-destructive/8 p-3 text-xs text-destructive">
                {importIssues.map((issue, index) => (
                  <li key={index}>{issue}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        {...searchableSetting("pet-position")}
        title="Size and position"
        icon={<PawPrintIcon className="size-4" />}
      >
        <SettingsRow
          title="Size"
          description="The pet renders at 96px (normal) and scales from there."
          control={
            <Select
              value={String(settings.scale)}
              onValueChange={(value) => patch({ scale: Number(value) as PetScale })}
              items={PET_SCALES}
            >
              <SelectTrigger className="w-32" aria-label="Pet size">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {PET_SCALES.map((scale) => (
                  <SelectItem key={scale.value} value={String(scale.value)}>
                    {scale.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Anchor"
          description="Which corner or edge the pet sticks to."
          control={
            <Select
              value={settings.anchor}
              onValueChange={(value) => patch({ anchor: value as PetSettings["anchor"] })}
              items={PET_ANCHORS.map((anchor) => ({
                value: anchor,
                label: anchor.replace("-", " "),
              }))}
            >
              <SelectTrigger className="w-40" aria-label="Pet anchor">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {PET_ANCHORS.map((anchor) => (
                  <SelectItem key={anchor} value={anchor}>
                    {anchor.replace("-", " ")}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Offsets"
          description="Distance from the anchor edge, in pixels."
          control={
            <div className="flex items-center gap-2">
              <Input
                type="number"
                aria-label="Horizontal offset"
                className="w-20"
                value={settings.offsetX}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isFinite(value)) patch({ offsetX: value });
                }}
              />
              <Input
                type="number"
                aria-label="Vertical offset"
                className="w-20"
                value={settings.offsetY}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isFinite(value)) patch({ offsetY: value });
                }}
              />
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection
        {...searchableSetting("pet-behavior")}
        title="Behavior"
        icon={<PawPrintIcon className="size-4" />}
      >
        <SettingsRow
          title="Follow"
          description="Which agent the pet represents when several are active."
          control={
            <Select
              value={settings.followMode}
              onValueChange={(value) => patch({ followMode: value as PetFollowMode })}
              items={PET_FOLLOW_MODES}
            >
              <SelectTrigger className="w-48" aria-label="Pet follow mode">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {PET_FOLLOW_MODES.map((mode) => (
                  <SelectItem key={mode.value} value={mode.value}>
                    {mode.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Reduced motion"
          description="Show a static frame instead of animating. The status bubble still communicates state."
          control={
            <Switch
              checked={settings.reducedMotion}
              onCheckedChange={(checked) => patch({ reducedMotion: checked })}
              aria-label="Reduced motion"
            />
          }
        />
        <SettingsRow
          title="Mouse tracking"
          description="The pet looks toward the cursor (requires a look-direction pet)."
          control={
            <Switch
              checked={settings.mouseTracking}
              onCheckedChange={(checked) => patch({ mouseTracking: checked })}
              aria-label="Mouse tracking"
            />
          }
        />
        <SettingsRow
          title="Sounds"
          description="Optional event sounds. Defaults to off."
          control={
            <Switch
              checked={settings.sounds}
              onCheckedChange={(checked) => patch({ sounds: checked })}
              aria-label="Pet sounds"
            />
          }
        />
        <SettingsRow
          title="Desktop overlay"
          description="Always on top, click-through and hide-on-fullscreen apply to the desktop overlay window."
        >
          <div className="flex flex-wrap gap-4 pt-2">
            <SwitchRow
              label="Always on top"
              checked={settings.alwaysOnTop}
              onChange={(checked) => patch({ alwaysOnTop: checked })}
            />
            <SwitchRow
              label="Click-through"
              checked={settings.clickThrough}
              onChange={(checked) => patch({ clickThrough: checked })}
            />
            <SwitchRow
              label="Hide on fullscreen"
              checked={settings.hideOnFullscreen}
              onChange={(checked) => patch({ hideOnFullscreen: checked })}
            />
          </div>
        </SettingsRow>
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function SwitchRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-[13px] font-medium text-foreground">
      <Switch checked={checked} onCheckedChange={onChange} />
      {label}
    </label>
  );
}

/**
 * Static one-frame preview of a pet (no animation loop — perf).
 * Draws idle frame 0 once the atlas loads.
 */
function PetPreview({
  petId,
  installedPets,
  scale,
}: {
  petId: string;
  installedPets: ReadonlyArray<InstalledPet>;
  scale: PetScale;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<SpriteRenderer | null>(null);
  if (rendererRef.current === null) {
    rendererRef.current = new SpriteRenderer();
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const context = canvas.getContext("2d");
    if (context === null) return;
    let cancelled = false;

    const installed = installedPets.find((pet) => pet.id === petId);
    if (petId !== DEFAULT_PET_ID && installed === undefined) {
      return; // not installed yet; nothing to preview
    }
    const source =
      installed === undefined ? DEFAULT_PET_ASSET_URL : URL.createObjectURL(installed.spritesheet);
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      void createImageBitmap(image).then((bitmap) => {
        if (cancelled) {
          bitmap.close();
          return;
        }
        const { width, height } = renderSize(scale);
        context.clearRect(0, 0, canvas.width, canvas.height);
        rendererRef.current?.render(context, {
          image: bitmap,
          width,
          height,
          override: { state: "idle", frame: 0 },
        });
        bitmap.close();
      });
    };
    image.src = source;
    return () => {
      cancelled = true;
      if (source.startsWith("blob:")) URL.revokeObjectURL(source);
    };
  }, [installedPets, petId, scale]);

  const { width, height } = renderSize(scale);
  return (
    <canvas
      ref={canvasRef}
      width={Math.round(width * 2)}
      height={Math.round(height * 2)}
      style={{ width, height, imageRendering: "pixelated", display: "block" }}
      aria-hidden
    />
  );
}
