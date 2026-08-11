import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { RouterProvider } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";
import { AppRoot } from "./AppRoot";

describe("AppRoot", () => {
  it("shares the application atom registry with routed UI (desktop hosts are Electron-only and lazy)", () => {
    const root = AppRoot({ router: {} as AppRouter });

    expect(root.type).toBe(AppAtomRegistryProvider);
    const children = Children.toArray(
      (root as ReactElement<{ readonly children: ReactNode }>).props.children,
    );
    // In a plain browser the desktop hosts render nothing, so only the router
    // is mounted — their code is split off and fetched only by the Electron shell.
    expect(children).toHaveLength(1);
    expect(isValidElement(children[0]) && children[0].type).toBe(RouterProvider);
  });
});
