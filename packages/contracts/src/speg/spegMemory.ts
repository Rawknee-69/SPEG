import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt } from "../baseSchemas.ts";
import { SpegMemoryId } from "./spegBaseSchemas.ts";

export const MemoryQueryParams = Schema.Struct({
  query: Schema.String,
  limit: Schema.optional(PositiveInt),
  threshold: Schema.optional(Schema.Number),
  tags: Schema.optional(Schema.Array(Schema.String)),
  scope: Schema.optional(Schema.String),
});
export type MemoryQueryParams = typeof MemoryQueryParams.Type;

export const MemoryEntrySummary = Schema.Struct({
  id: SpegMemoryId,
  content: Schema.String,
  memoryType: Schema.String,
  confidence: Schema.Number,
  tags: Schema.Array(Schema.String),
  source: Schema.String,
});
export type MemoryEntrySummary = typeof MemoryEntrySummary.Type;

export const MemorySearchResult = Schema.Struct({
  entries: Schema.Array(MemoryEntrySummary),
  totalCount: NonNegativeInt,
  searchTimeMs: NonNegativeInt,
});
export type MemorySearchResult = typeof MemorySearchResult.Type;
