import { createFileRoute } from "@tanstack/react-router";

import { ScheduledTasksSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/settings/scheduled")({
  component: ScheduledTasksSettingsPanel,
});
