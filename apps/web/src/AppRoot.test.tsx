import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { RouterProvider } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";
import { PetOverlay } from "./pets/PetOverlay";
import { AppRoot } from "./AppRoot";

describe("AppRoot", () => {
  it("shares the application atom registry with routed UI (desktop hosts are Electron-only and lazy)", () => {
    const router = {} as AppRouter;
    const root = AppRoot({ router });

    expect(root.type).toBe(AppAtomRegistryProvider);
    const children = Children.toArray(
      (root as ReactElement<{ readonly children: ReactNode }>).props.children,
    );
    // In a plain browser the desktop hosts render nothing: the router and the
    // pet overlay mount, and nothing else (host code is split off and fetched
    // only by the Electron shell).
    expect(children).toHaveLength(2);
    expect(isValidElement(children[0]) && children[0].type).toBe(RouterProvider);
    expect(isValidElement(children[1]) && children[1].type).toBe(PetOverlay);
    // The pet receives the router instance (it sits outside RouterProvider, so
    // useNavigate would resolve to an undefined router).
    expect(
      isValidElement(children[1]) &&
        (children[1] as ReactElement<{ router?: AppRouter }>).props.router,
    ).toBe(router);
  });
});
