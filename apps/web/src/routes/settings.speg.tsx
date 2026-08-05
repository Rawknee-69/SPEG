import { createFileRoute } from "@tanstack/react-router";

import { SpegSettings } from "../components/speg/SpegSettings";

function SettingsSpegRoute() {
  return <SpegSettings />;
}

export const Route = createFileRoute("/settings/speg")({
  component: SettingsSpegRoute,
});
