import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { ProjectScriptIcon } from "./orchestration.ts";

/** File name of the checked-in SPEG project file, resolved at the workspace root. */
export const SPEG_PROJECT_FILE_NAME = "speg.json";

/** Public URL of the published JSON Schema for {@link SpegProjectFile}. */
export const SPEG_PROJECT_FILE_SCHEMA_URL = "https://t3.codes/schema/t3.json";

const SPEG_PROJECT_FILE_PATH_MAX_LENGTH = 512;
const SPEG_PROJECT_FILE_MAX_SCRIPTS = 50;

// Annotations go on the encoded (string) side so they survive into the
// published JSON Schema; decoding still trims and re-validates non-emptiness.
const trimmedNonEmpty = (annotations: { readonly description: string }, maxLength?: number) => {
  const annotated = Schema.String.annotate(annotations);
  const encoded =
    maxLength === undefined
      ? annotated.check(Schema.isNonEmpty())
      : annotated.check(Schema.isNonEmpty(), Schema.isMaxLength(maxLength));
  return encoded.pipe(Schema.decodeTo(encoded, SchemaTransformation.trim()));
};

export const SpegProjectFileScript = Schema.Struct({
  name: trimmedNonEmpty({
    description: "Display name for the script, shown in the SPEG scripts menu.",
  }),
  command: trimmedNonEmpty({
    description: "Shell command executed in a SPEG terminal at the project root.",
  }),
  icon: Schema.optionalKey(
    ProjectScriptIcon.annotate({
      description: 'Icon shown next to the script in the scripts menu. Defaults to "play".',
    }),
  ),
  runOnWorktreeCreate: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, the script runs automatically after a worktree is created for a new thread.",
    }),
  ),
  previewUrl: Schema.optionalKey(
    trimmedNonEmpty({
      description:
        "URL opened in the in-app browser preview when this script runs. Only honored on the desktop build.",
    }),
  ),
  autoOpenPreview: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, automatically open the preview panel at `previewUrl` the moment the script starts.",
    }),
  ),
}).annotate({
  description: "A project script that team members can import into SPEG.",
});
export type SpegProjectFileScript = typeof SpegProjectFileScript.Type;

export const SpegProjectFile = Schema.Struct({
  $schema: Schema.optionalKey(
    Schema.String.annotate({
      description: `URL of the JSON Schema for this file, typically "${SPEG_PROJECT_FILE_SCHEMA_URL}".`,
    }),
  ),
  iconPath: Schema.optionalKey(
    trimmedNonEmpty(
      {
        description:
          'Workspace-relative path to the project icon (e.g. "assets/logo.svg"). Checked before SPEG\'s built-in icon locations.',
      },
      SPEG_PROJECT_FILE_PATH_MAX_LENGTH,
    ),
  ),
  scripts: Schema.optionalKey(
    Schema.Array(SpegProjectFileScript)
      .annotate({
        description: "Project scripts shared with everyone who opens this repository in SPEG.",
      })
      .check(Schema.isMaxLength(SPEG_PROJECT_FILE_MAX_SCRIPTS)),
  ),
}).annotate({
  title: "SPEG project file",
  description:
    "Checked-in project configuration for SPEG (speg.json at the repository root). See https://t3.codes for documentation.",
});
export type SpegProjectFile = typeof SpegProjectFile.Type;
