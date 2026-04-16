import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "iris",
  name: "Iris Gateway",
  description:
    "Unified messaging gateway channel — routes WeChat, Feishu, Telegram and other channels through iris into openclaw.",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./api.js",
    exportName: "irisPlugin",
  },
  secrets: {
    specifier: "./secret-contract-api.js",
    exportName: "channelSecrets",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setIrisRuntime",
  },
});
