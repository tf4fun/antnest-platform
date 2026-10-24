import { EventEmitter } from "node:events";
import type { RawData } from "ws";
import { strictObject } from "../adapters/strict-json.js";

export type PeerWireSocket = Pick<EventEmitter, "on" | "once"> & {
  readyState: number;
  send(value: string, done: (error?: Error | null) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
};
export class PeerReceiptDeliveryError extends Error {
  public constructor(cause: unknown) {
    super("Peer cleanup receipt was not delivered after local cleanup", { cause });
  }
}

/** ACP frames and lifecycle acknowledgements have distinct, closed envelopes. */
export class PeerSocket extends EventEmitter {
  private ended = false;
  private readonly writes = new Set<Promise<void>>();
  private readonly failures: unknown[] = [];
  private readonly physical = Promise.withResolvers<void>();
  private readonly receipt = Promise.withResolvers<void>();
  private receivedReceipt = false;

  public constructor(
    private readonly wire: PeerWireSocket,
    private readonly side: "owner" | "ingress",
    private readonly requestId: string,
    private readonly maximum: number,
  ) {
    super();
    void this.receipt.promise.catch(() => undefined);
    wire.on("message", (data: RawData, binary: boolean) => this.receive(data, binary));
    wire.once("error", () => {
      this.failures.push(new Error("Peer connection failed"));
      this.end(1011, "Peer connection failed");
    });
    wire.once("close", () => {
      this.end(1001, "Peer connection closed");
      if (!this.receivedReceipt && this.side === "ingress")
        this.receipt.reject(new Error("Peer cleanup outcome is unknown"));
      this.physical.resolve();
    });
  }

  public send(value: string, done?: (error?: Error) => void): void {
    void this.forward(Buffer.from(value), false).then(
      () => done?.(),
      () => done?.(new Error("Peer frame delivery failed")),
    );
  }
  public forward(value: RawData, binary: boolean): Promise<void> {
    const bytes = frameBytes(value);
    if (this.ended || bytes.length > this.maximum)
      return Promise.reject(new Error("Peer frame unavailable"));
    return this.write({ type: "frame", binary, payload: bytes.toString("base64") });
  }
  public close(code = 1000, reason: string | Buffer = "ACP connection closed"): void {
    if (this.ended) return;
    const text = Buffer.isBuffer(reason) ? reason.toString("utf8") : reason;
    this.end(code, text);
    void this.write({ type: "close", code, reason: text }).catch(() => undefined);
  }
  private end(code: number, reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.emit("close", code, Buffer.from(reason));
  }

  /** Called only after the owner's original SDK and ConnectionTasks have joined. */
  public async finishOwner(): Promise<void> {
    if (this.side !== "owner") throw new Error("Invalid peer receipt issuer");
    try {
      await this.drainWrites();
      await this.write({ type: "joined", request_id: this.requestId });
      this.wire.close(1000, "Owner cleanup joined");
    } catch (error) {
      this.wire.terminate();
      await this.physical.promise;
      await Promise.allSettled([...this.writes]);
      throw new PeerReceiptDeliveryError(error);
    }
    await this.physical.promise;
    if (this.failures.length)
      throw new PeerReceiptDeliveryError(
        new AggregateError(this.failures, "Owner peer cleanup failed"),
      );
  }
  public async finishIngress(): Promise<void> {
    if (this.side !== "ingress") throw new Error("Invalid peer receipt receiver");
    this.close();
    const results = await Promise.allSettled([
      this.receipt.promise,
      this.physical.promise,
      this.drainWrites(),
    ]);
    const errors = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (errors.length || this.failures.length)
      throw new AggregateError(
        [...errors.map((result) => result.reason as unknown), ...this.failures],
        "Peer cleanup outcome is unknown",
      );
  }
  private async drainWrites(): Promise<void> {
    while (this.writes.size) await Promise.allSettled([...this.writes]);
    if (this.failures.length) throw new AggregateError(this.failures, "Peer sends failed");
  }
  private write(message: Record<string, unknown>): Promise<void> {
    const result = Promise.withResolvers<void>();
    this.writes.add(result.promise);
    const finish = (error?: Error | null) => {
      this.writes.delete(result.promise);
      if (error == null) result.resolve();
      else {
        this.failures.push(error);
        result.reject(error);
      }
    };
    try {
      if (this.wire.readyState !== 1) finish(new Error("Peer socket is closed"));
      else this.wire.send(JSON.stringify(message), finish);
    } catch {
      finish(new Error("Peer send failed"));
    }
    void result.promise.catch(() => undefined);
    return result.promise;
  }
  private receive(data: RawData, binary: boolean): void {
    try {
      if (binary) throw new Error();
      const bytes = frameBytes(data);
      if (bytes.length > this.maximum * 2 + 1024) throw new Error();
      const value = strictObject(bytes);
      if (value.type === "frame") {
        if (
          Object.keys(value).length !== 3 ||
          typeof value.binary !== "boolean" ||
          typeof value.payload !== "string"
        )
          throw new Error();
        const payload = Buffer.from(value.payload, "base64");
        if (payload.length > this.maximum || payload.toString("base64") !== value.payload)
          throw new Error();
        // Frames already in flight when logical close crossed the wire are not
        // new dispatches and must not destroy the owner's cleanup receipt.
        if (this.ended) return;
        this.emit("message", payload, value.binary);
      } else if (value.type === "close") {
        if (
          Object.keys(value).length !== 3 ||
          typeof value.code !== "number" ||
          !Number.isInteger(value.code) ||
          !validClose(value.code) ||
          typeof value.reason !== "string" ||
          Buffer.byteLength(value.reason) > 123
        )
          throw new Error();
        this.end(value.code, value.reason);
      } else if (value.type === "joined") {
        if (
          this.side !== "ingress" ||
          Object.keys(value).length !== 2 ||
          value.request_id !== this.requestId ||
          this.receivedReceipt
        )
          throw new Error();
        this.receivedReceipt = true;
        this.receipt.resolve();
        this.end(1000, "Owner cleanup joined");
      } else throw new Error();
    } catch {
      this.failures.push(new Error("Invalid peer frame"));
      this.wire.terminate();
    }
  }
}
function validClose(code: number): boolean {
  return (
    (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
    (code >= 3000 && code <= 4999)
  );
}
export function frameBytes(value: RawData): Buffer {
  return Array.isArray(value)
    ? Buffer.concat(value)
    : value instanceof ArrayBuffer
      ? Buffer.from(value)
      : value;
}
