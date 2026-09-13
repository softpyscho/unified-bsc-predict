/** In-process event bus feeding the SSE stream. Listener failures never affect the publisher. */

export type AppEventType =
  'market' | 'bot' | 'decision' | 'trade' | 'audit' | 'sync' | 'backtest' | 'portfolio';

export interface AppEvent {
  type: AppEventType;
  data: unknown;
}

export class EventBus {
  private readonly listeners = new Set<(e: AppEvent) => void>();

  on(listener: (e: AppEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(type: AppEventType, data: unknown): void {
    for (const l of this.listeners) {
      try {
        l({ type, data });
      } catch {
        // A broken subscriber (e.g. a closed SSE socket) must not break the publisher.
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}
