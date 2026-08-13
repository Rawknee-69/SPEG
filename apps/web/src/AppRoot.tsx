import { lazy, Suspense } from "react";
import { RouterProvider } from "@tanstack/react-router";

import { isElectron } from "./env";
import { PetOverlay } from "./pets/PetOverlay";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

// Desktop-only hosts: in the browser they render nothing, so the code is
// split off and only fetched when the Electron shell actually mounts them.
const ElectronBrowserHost = lazy(() =>
  import("./browser/ElectronBrowserHost").then((module) => ({
    default: module.ElectronBrowserHost,
  })),
);
const PreviewAutomationHosts = lazy(() =>
  import("./components/preview/PreviewAutomationHosts").then((module) => ({
    default: module.PreviewAutomationHosts,
  })),
);

/**
 * Owns renderer-wide providers. The Electron browser host intentionally sits
 * outside the router so its webviews survive route transitions, but it must
 * share the same atom registry as routed UI.
 */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
      <PetOverlay />
      {isElectron ? (
        <Suspense fallback={null}>
          <PreviewAutomationHosts />
          <ElectronBrowserHost />
        </Suspense>
      ) : null}
    </AppAtomRegistryProvider>
  );
}
