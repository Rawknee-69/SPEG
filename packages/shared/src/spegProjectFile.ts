import * as Schema from "effect/Schema";

import { SpegProjectFile, SPEG_PROJECT_FILE_SCHEMA_URL } from "@speg/contracts";

import { fromLenientJson } from "./schemaJson.ts";

/**
 * Codec between the raw `speg.json` file contents (lenient JSONC string) and the
 * decoded {@link SpegProjectFile}.
 */
export const SpegProjectFileFromJson = fromLenientJson(SpegProjectFile);

/**
 * Build the publishable JSON Schema document for `speg.json` (draft 2020-12).
 *
 * Served from the marketing site at {@link SPEG_PROJECT_FILE_SCHEMA_URL} so
 * editors get LSP support via a `$schema` reference.
 */
export function buildSpegProjectFileJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(SpegProjectFile);
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: SPEG_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
