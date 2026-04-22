import { ChannelAdapter } from './types';
import { IrisMessage } from '../message';
import { FastifyInstance } from 'fastify';

class ChannelAdapterRegistry {
  private readonly adapters = new Map<string, ChannelAdapter>();

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  list(): ChannelAdapter[] {
    return Array.from(this.adapters.values());
  }

  resolveByMessage(message: IrisMessage): ChannelAdapter | undefined {
    const byName = this.adapters.get(message.channel);
    if (byName) return byName;
    return this.list().find((adapter) => adapter.support(message));
  }

  run(server: FastifyInstance) {
    this.adapters.forEach((adapter) => {
      adapter.register(server);
    });
  }
}

export const channelAdapterRegistry = new ChannelAdapterRegistry();
