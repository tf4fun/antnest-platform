/** Owns connection work through actual settlement, independently of cancellation races. */
export class ConnectionTasks {
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;
  private closing: Promise<void> | undefined;

  public run<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.closed) {
      const rejected = Promise.reject<T>(
        new DOMException("ACP connection is closed", "AbortError"),
      );
      void rejected.catch(() => undefined);
      return rejected;
    }
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    this.pending.add(promise);
    const forget = () => {
      this.pending.delete(promise);
    };
    void promise.then(forget, forget);
    try {
      resolve(operation());
    } catch (error) {
      reject(error);
    }
    return promise;
  }

  public close(): Promise<void> {
    this.closed = true;
    return (this.closing ??= Promise.allSettled([...this.pending]).then(() => undefined));
  }

  public wrap<T extends object>(target: T): T {
    // The wrapped facade's methods must be asynchronous. Keep the real receiver
    // so class-private fields work, and own only the returned promise itself.
    return new Proxy(target, {
      get: (original, key) => {
        const value: unknown = Reflect.get(original, key, original);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) =>
          this.run(() => Reflect.apply(value, original, args) as unknown);
      },
    });
  }
}
