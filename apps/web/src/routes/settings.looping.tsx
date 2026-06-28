import { createFileRoute } from "@tanstack/react-router";

import { LoopingSettingsPanel } from "../components/settings/LoopingSettings";

function SettingsLoopingRoute() {
  return <LoopingSettingsPanel />;
}

export const Route = createFileRoute("/settings/looping")({
  component: SettingsLoopingRoute,
});
