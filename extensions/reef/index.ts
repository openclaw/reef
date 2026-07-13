import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/core";
import { ReefChannelConfigSchema } from "./src/config-schema.js";
import { registerReefCommands } from "./src/commands.js";

export default defineBundledChannelEntry({
  id: "reef",
  name: "Reef",
  description: "Guarded end-to-end encrypted claw channel",
  importMetaUrl: import.meta.url,
  plugin: { specifier: "./channel-plugin-api.js", exportName: "reefPlugin" },
  outbound: { specifier: "./api.js", exportName: "reefOutboundAdapter" },
  runtime: { specifier: "./runtime-api.js", exportName: "setReefRuntime" },
  configSchema: () => buildChannelConfigSchema(ReefChannelConfigSchema),
  registerFull: registerReefCommands,
});
