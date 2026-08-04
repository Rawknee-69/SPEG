import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "../baseSchemas.ts";

/**
 * Construct a branded identifier. Enforces non-empty trimmed strings.
 * Mirrors the `makeEntityId` helper in baseSchemas.ts.
 */
const makeEntityId = <Brand extends string>(brand: Brand) => {
  return TrimmedNonEmptyString.pipe(Schema.brand(brand));
};

export const SpegSessionId = makeEntityId("SpegSessionId");
export type SpegSessionId = typeof SpegSessionId.Type;

export const SpegMemoryId = makeEntityId("SpegMemoryId");
export type SpegMemoryId = typeof SpegMemoryId.Type;

export const SpegContextId = makeEntityId("SpegContextId");
export type SpegContextId = typeof SpegContextId.Type;
