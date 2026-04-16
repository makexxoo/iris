import { PluginContext } from '../message';

export interface Plugin {
  name: string;
  /** Called once on startup to perform any initialisation */
  init?(): Promise<void>;
  /** Mutates ctx.business to inject data; can also read/write ctx.session */
  execute(ctx: PluginContext): Promise<void>;
}
