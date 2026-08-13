import type { DecodedImage, PetManifest } from "@speg/pets";
import { validateManifest, validatePetAtlas } from "@speg/pets";

import defaultPetWebpUrl from "~/assets/pets/default.webp";

/** Built-in pet id, matching apps/web/src/assets/pets/default.webp. */
export const DEFAULT_PET_ID = "spark";

export const DEFAULT_PET_MANIFEST: PetManifest = {
  id: DEFAULT_PET_ID,
  displayName: "Spark",
  description: "The built-in SPEG companion, drawn into the V1 sprite atlas.",
  spriteVersionNumber: 1,
  spritesheetPath: "default.webp",
};

export const DEFAULT_PET_ASSET_URL = defaultPetWebpUrl;

// ── Custom pet registry (IndexedDB, browser-local) ─────────────────

export interface InstalledPet {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly manifest: PetManifest;
  /** The validated spritesheet bytes (WebP/PNG). */
  readonly spritesheet: Blob;
  readonly createdAt: number;
}

const PET_DB_NAME = "speg-pets";
const PET_DB_VERSION = 1;
const PET_STORE_NAME = "custom-pets";

function openPetDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PET_DB_NAME, PET_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PET_STORE_NAME)) {
        db.createObjectStore(PET_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("could not open pet database"));
  });
}

async function withPetStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openPetDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(PET_STORE_NAME, mode);
      const request = run(transaction.objectStore(PET_STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("pet store request failed"));
    });
  } finally {
    db.close();
  }
}

export function listInstalledPets(): Promise<InstalledPet[]> {
  return withPetStore("readonly", (store) => store.getAll() as IDBRequest<InstalledPet[]>);
}

export function saveInstalledPet(pet: InstalledPet): Promise<void> {
  return withPetStore("readwrite", (store) => store.put(pet) as unknown as IDBRequest<void>);
}

export function deleteInstalledPet(id: string): Promise<void> {
  return withPetStore("readwrite", (store) => store.delete(id) as unknown as IDBRequest<void>);
}

// ── Package import + validation ────────────────────────────────────

export interface PetImportResult {
  readonly ok: boolean;
  readonly pet?: InstalledPet;
  readonly issues?: readonly string[];
}

/**
 * Validate and install a custom pet package (pet.json + spritesheet), spec
 * §79-80. Invalid packages never reach the registry and the app never crashes
 * on a broken pet (§84).
 */
export async function importPetPackage(input: {
  readonly manifestJson: string;
  readonly spritesheet: File;
}): Promise<PetImportResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(input.manifestJson);
  } catch {
    return { ok: false, issues: ["pet.json is not valid JSON."] };
  }

  const manifestCheck = validateManifest(raw);
  if (!manifestCheck.ok || manifestCheck.manifest === null) {
    return { ok: false, issues: manifestCheck.issues.map((issue) => issue.message) };
  }
  const manifest = manifestCheck.manifest;

  const decoded = await decodeImageFile(input.spritesheet);
  if (decoded === null) {
    return { ok: false, issues: ["The spritesheet could not be decoded as an image."] };
  }

  const atlasCheck = validatePetAtlas({ manifest, image: decoded });
  if (!atlasCheck.ok) {
    const warnings = atlasCheck.warnings.map((issue) => `Warning: ${issue.message}`);
    return { ok: false, issues: [...atlasCheck.errors.map((issue) => issue.message), ...warnings] };
  }

  const pet: InstalledPet = {
    id: manifest.id,
    displayName: manifest.displayName,
    description: manifest.description,
    manifest,
    spritesheet: input.spritesheet,
    createdAt: Date.now(),
  };
  await saveInstalledPet(pet);
  return { ok: true, pet };
}

function decodeImageFile(file: Blob): Promise<DecodedImage | null> {
  const url = URL.createObjectURL(file);
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d");
        if (context === null) {
          resolve(null);
          return;
        }
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        resolve({ width: canvas.width, height: canvas.height, data: pixels.data });
      } catch {
        resolve(null);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    image.src = url;
  });
}
