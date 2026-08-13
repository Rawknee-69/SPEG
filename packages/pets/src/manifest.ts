import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString, TrimmedString } from "@speg/contracts";
import { ATLAS_VERSION_V1 } from "./atlas.ts";

/**
 * pet.json manifest contract (spec §22, §77-78).
 *
 * Required fields are stable for spriteVersionNumber 1; everything else is
 * optional so optional fields never become mandatory. `spriteVersionNumber` is
 * decoded as 1 by default; loaders must reject unknown versions gracefully.
 */
export const PetManifest = Schema.Struct({
  id: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  description: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  // Decoded as a plain number so loaders can read any version and then reject
  // unsupported ones with a clear message (spec §78) instead of a schema error.
  spriteVersionNumber: PositiveInt.pipe(
    Schema.withDecodingDefault(Effect.succeed(ATLAS_VERSION_V1)),
  ),
  spritesheetPath: TrimmedNonEmptyString,
  author: Schema.optional(TrimmedString),
  license: Schema.optional(TrimmedString),
  style: Schema.optional(TrimmedString),
  capabilities: Schema.optional(
    Schema.Struct({
      lookDirection: Schema.optional(Schema.Boolean),
      interaction: Schema.optional(Schema.Boolean),
    }),
  ),
});
export type PetManifest = typeof PetManifest.Type;

/** The highest sprite version this runtime supports. */
export const MAX_SUPPORTED_SPRITE_VERSION = ATLAS_VERSION_V1;

export interface ManifestValidationIssue {
  readonly code: string;
  readonly message: string;
}

/**
 * Decode a raw pet.json value into a PetManifest. Returns an array of issues
 * (empty on success) rather than throwing, so callers can surface actionable
 * messages ("manifest is missing `id`") without crashing the app (spec §55, §84).
 */
export function validateManifest(raw: unknown): {
  readonly ok: boolean;
  readonly manifest: PetManifest | null;
  readonly issues: readonly ManifestValidationIssue[];
} {
  let manifest: PetManifest;
  try {
    manifest = Schema.decodeUnknownSync(PetManifest)(raw);
  } catch (error) {
    const detail = Schema.isSchemaError(error) ? error.message : "not a valid pet.json";
    return {
      ok: false,
      manifest: null,
      issues: [{ code: "manifest.invalid", message: `manifest: ${detail}` }],
    };
  }

  if (manifest.spriteVersionNumber > MAX_SUPPORTED_SPRITE_VERSION) {
    return {
      ok: false,
      manifest: null,
      issues: [
        {
          code: "sprite.version.unsupported",
          message: `This pet requires sprite version ${manifest.spriteVersionNumber}. Your application supports version ${MAX_SUPPORTED_SPRITE_VERSION}.`,
        },
      ],
    };
  }

  return { ok: true, manifest, issues: [] };
}
