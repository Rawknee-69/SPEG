import type { APIRoute } from "astro";

import { buildSpegProjectFileJsonSchema } from "@speg/shared/spegProjectFile";

// Rendered at build time; published at https://t3.codes/schema/t3.json so
// speg.json files can reference it via "$schema" for editor/LSP support.
export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildSpegProjectFileJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
