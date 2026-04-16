import { PluginContext } from '../message';
import { Plugin } from './types';

export class PluginPipeline {
  private plugins: Plugin[] = [];

  register(plugin: Plugin): void {
    this.plugins.push(plugin);
  }

  async init(): Promise<void> {
    for (const plugin of this.plugins) {
      if (plugin.init) {
        await plugin.init();
      }
    }
  }

  /** Run all plugins in registration order, passing the same ctx through each */
  async run(ctx: PluginContext): Promise<void> {
    for (const plugin of this.plugins) {
      await plugin.execute(ctx);
    }
  }
}
