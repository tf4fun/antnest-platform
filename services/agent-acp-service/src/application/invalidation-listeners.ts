export class InvalidationListeners {
  private readonly listeners = new Map<string, Set<{ notify: () => void }>>();

  public subscribe(key: string, listener: () => void): () => void {
    const listeners = this.listeners.get(key) ?? new Set<{ notify: () => void }>();
    const subscription = { notify: listener };
    listeners.add(subscription);
    this.listeners.set(key, listeners);
    return () => {
      if (!listeners.delete(subscription)) return;
      if (listeners.size === 0 && this.listeners.get(key) === listeners) this.listeners.delete(key);
    };
  }

  public invalidate(key: string): void {
    for (const listener of this.listeners.get(key) ?? []) {
      try {
        listener.notify();
      } catch {
        // Notifications are hints, never execution ownership. Reconnect reads
        // the authoritative view instead of relying on a delivered event log.
      }
    }
  }
}
