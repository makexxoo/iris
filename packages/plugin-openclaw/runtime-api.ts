/**
 * Runtime injection entry for the iris channel plugin.
 *
 * External plugins that use `ctx.channelRuntime` in `startAccount` don't need
 * a separate runtime setter — the runtime is passed directly via the gateway
 * context. This file is kept as a placeholder to satisfy the
 * `defineBundledChannelEntry` contract.
 */
export function setIrisRuntime(_runtime: unknown): void {
  // No-op: iris uses ctx.channelRuntime injected by openclaw at gateway start.
}
