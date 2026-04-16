/**
 * Secrets contract for the iris channel.
 * Iris uses a simple URL + optional webhook secret stored in the openclaw config file.
 * No token rotation or OAuth flows are needed.
 */
export const channelSecrets = {
  secretTargetRegistryEntries: [] as const,
};
