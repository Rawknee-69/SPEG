import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { PetOverlay } from "./PetOverlay";

/**
 * Pet-only boot surface for the desktop transparent overlay window
 * (loaded via `?surface=pet`). No router, no chat, no Clerk — just the
 * atom registry the pet needs and the pet itself (spec §12, §39).
 */
export function PetOverlaySurface() {
  return (
    <AppAtomRegistryProvider>
      <PetOverlay overlay />
    </AppAtomRegistryProvider>
  );
}
