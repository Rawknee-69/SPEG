import {
  SPEG_PROJECT_FILE_NAME,
  type EnvironmentId,
  type SpegProjectFileScript,
} from "@speg/contracts";
import { SpegProjectFileFromJson } from "@speg/shared/spegProjectFile";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { useMemo } from "react";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const decodeSpegProjectFile = Schema.decodeExit(SpegProjectFileFromJson);

const NO_SCRIPTS: ReadonlyArray<SpegProjectFileScript> = [];

/**
 * Scripts declared in the project's checked-in `speg.json`, offered in the
 * scripts menu for import. Missing, truncated, or invalid files resolve to
 * an empty list.
 */
export function useSpegProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<SpegProjectFileScript> {
  const query = useProjectFileQuery(environmentId, cwd ?? "", SPEG_PROJECT_FILE_NAME, cwd !== null);
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  return useMemo(() => {
    if (contents === null) return NO_SCRIPTS;
    const decoded = decodeSpegProjectFile(contents);
    if (Exit.isFailure(decoded)) return NO_SCRIPTS;
    return decoded.value.scripts ?? NO_SCRIPTS;
  }, [contents]);
}
