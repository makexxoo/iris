import { ChannelAdapter } from './types';
import { IrisMessage } from '../message';
import { FastifyInstance } from 'fastify';

class ChannelAdapterRegistry {
  private readonly adapters = new Set<ChannelAdapter>();

  register(adapter: ChannelAdapter): void {
    this.adapters.add(adapter);
  }

  list(): ChannelAdapter[] {
    return Array.from(this.adapters.values());
  }

  resolveByMessage(message: IrisMessage): ChannelAdapter | undefined {
    return this.list().find((adapter) => adapter.support(message));
  }

  run(server: FastifyInstance) {
    this.adapters.forEach((adapter) => {
      adapter.register(server);
    });
  }
}

export const channelAdapterRegistry = new ChannelAdapterRegistry();
