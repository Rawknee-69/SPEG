import React from "react";
import ReactDOM from "react-dom/client";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "./index.css";

import { isElectron } from "./env";
import { hasCloudPublicConfig } from "./cloud/publicConfig";
import { ManagedRelayAuthProvider } from "./cloud/managedAuth";
import { getRouter } from "./router";
import {
  syncDocumentElectronPlatformClasses,
  syncDocumentWindowControlsOverlayClass,
} from "./lib/windowControlsOverlay";
import { AppRoot } from "./AppRoot";
import { PetOverlaySurface } from "./pets/PetOverlaySurface";

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

if (isElectron) {
  syncDocumentElectronPlatformClasses(navigator.platform);
  syncDocumentWindowControlsOverlayClass();
}

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

const app = <AppRoot router={router} />;

// The desktop pet overlay window loads this same bundle with `?surface=pet`
// and renders ONLY the pet — no router, no chat, no Clerk (spec §12).
const isPetSurface = new URLSearchParams(window.location.search).get("surface") === "pet";
if (isPetSurface) {
  const container = document.getElementById("root") as HTMLElement;
  ReactDOM.createRoot(container).render(<PetOverlaySurface />);
} else {
  // Single root on `#root`: this branch is the ONLY renderApp() call, so the
  // container never gets a second concurrent React root (two roots on one
  // container fight over the DOM and freeze the app with removeChild /
  // insertBefore "not a child of this node" errors).
  void renderApp();
}

/**
 * Clerk's runtime is ~9.6 MB unpacked; it is only mounted when a cloud public
 * config is baked into the build, so it is imported lazily instead of being
 * parsed on every boot. The auth gate still blocks first paint the same way.
 */
async function renderApp(): Promise<void> {
  const container = document.getElementById("root") as HTMLElement;
  const root = ReactDOM.createRoot(container);

  if (clerkPublishableKey && hasCloudPublicConfig()) {
    try {
      if (isElectron) {
        const [{ ClerkProvider: ElectronClerkProvider }, { passkeys }] = await Promise.all([
          import("@clerk/electron/react"),
          import("@clerk/electron/passkeys"),
        ]);
        root.render(
          <React.StrictMode>
            <ElectronClerkProvider publishableKey={clerkPublishableKey} passkeys={passkeys}>
              <ManagedRelayAuthProvider>{app}</ManagedRelayAuthProvider>
            </ElectronClerkProvider>
          </React.StrictMode>,
        );
        return;
      }
      const [{ ClerkProvider }] = await Promise.all([import("@clerk/react")]);
      root.render(
        <React.StrictMode>
          <ClerkProvider publishableKey={clerkPublishableKey}>
            <ManagedRelayAuthProvider>{app}</ManagedRelayAuthProvider>
          </ClerkProvider>
        </React.StrictMode>,
      );
      return;
    } catch {
      // A chunk-load failure must not leave a blank screen: fall back to the
      // unauthenticated app (the auth gate will surface the missing session).
    }
  }

  root.render(<React.StrictMode>{app}</React.StrictMode>);
}
