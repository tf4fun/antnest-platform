import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { PeerReceiptDeliveryError, PeerSocket } from "../../src/transport/peer-socket.js";

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  nullSuccess = false;
  send(value: string, done: (error?: Error | null) => void) {
    this.sent.push(value);
    done(this.nullSuccess ? null : undefined);
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
  terminate() {
    this.close();
  }
}
describe("peer cleanup receipt", () => {
  it("allows an in-flight frame to cross logical close without losing the cleanup receipt", async () => {
    const raw = new FakeSocket();
    const channel = new PeerSocket(raw, "ingress", "request-1", 1024);
    let delivered = false;
    channel.on("message", () => {
      delivered = true;
    });
    channel.close();
    raw.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "frame",
          binary: false,
          payload: Buffer.from("{}").toString("base64"),
        }),
      ),
      false,
    );
    expect(delivered).toBe(false);
    expect(raw.readyState).toBe(1);
    raw.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "joined", request_id: "request-1" })),
      false,
    );
    raw.close();
    await channel.finishIngress();
  });
  it("accepts Node socket null success callbacks", async () => {
    const raw = new FakeSocket();
    raw.nullSuccess = true;
    const channel = new PeerSocket(raw, "owner", "request-1", 1024);
    await expect(channel.forward(Buffer.from("{}"), false)).resolves.toBeUndefined();
    await channel.finishOwner();
  });
  it("does not manufacture joined from a remote close request", async () => {
    const raw = new FakeSocket();
    const channel = new PeerSocket(raw, "owner", "request-1", 1024);
    let closed = false;
    channel.once("close", () => {
      closed = true;
    });
    raw.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "close", code: 1000, reason: "done" })),
      false,
    );
    expect(closed).toBe(true);
    expect(raw.sent).toEqual([]);
    await channel.finishOwner();
    expect(raw.sent.map((value) => JSON.parse(value) as unknown)).toEqual([
      { type: "joined", request_id: "request-1" },
    ]);
  });
  it("rejects disconnected cleanup without a matching owner receipt", async () => {
    const raw = new FakeSocket();
    const channel = new PeerSocket(raw, "ingress", "request-1", 1024);
    raw.close();
    await expect(channel.finishIngress()).rejects.toThrow("cleanup");
  });
  it("keeps user JSON separate from cleanup control", async () => {
    const raw = new FakeSocket();
    const channel = new PeerSocket(raw, "ingress", "request-1", 1024);
    await channel.forward(Buffer.from('{"type":"joined"}'), false);
    expect(JSON.parse(raw.sent[0]!)).toEqual({
      type: "frame",
      binary: false,
      payload: Buffer.from('{"type":"joined"}').toString("base64"),
    });
    raw.close();
    await expect(channel.finishIngress()).rejects.toThrow();
  });
  it.each(["frame-send", "invalid-frame", "joined-send"] as const)(
    "retains owner cleanup failure classification and joins physical close (%s)",
    async (scenario) => {
      const raw = new FakeSocket();
      const terminating = Promise.withResolvers<void>();
      raw.terminate = () => {
        raw.readyState = 2;
        terminating.resolve();
      };
      const sentinel = new Error(`original-${scenario}-failure`);
      raw.send = (value, done) => {
        raw.sent.push(value);
        const message = JSON.parse(value) as { type: string };
        done(
          (scenario === "frame-send" && message.type === "frame") ||
            (scenario === "joined-send" && message.type === "joined")
            ? sentinel
            : undefined,
        );
      };
      const channel = new PeerSocket(raw, "owner", "request-owner-failure", 1024);
      if (scenario === "frame-send") {
        await expect(channel.forward(Buffer.from("{}"), false)).rejects.toBe(sentinel);
      } else if (scenario === "invalid-frame") {
        raw.emit("message", Buffer.from('{"type":"invalid"}'), false);
      } else {
        await expect(channel.forward(Buffer.from("{}"), false)).resolves.toBeUndefined();
      }
      let finished = false;
      const original = channel.finishOwner();
      const outcome = original.then(
        () => {
          finished = true;
          return { error: undefined };
        },
        (error: unknown) => {
          finished = true;
          return { error };
        },
      );
      const chain = (error: unknown): unknown[] => [
        error,
        ...(error instanceof AggregateError
          ? error.errors.flatMap((item: unknown) => chain(item))
          : []),
        ...(error instanceof Error && error.cause !== undefined ? chain(error.cause) : []),
      ];
      try {
        await terminating.promise;
        await Promise.resolve();
        expect(finished).toBe(false);
        raw.close();
        const { error } = await outcome;
        expect(error).toBeInstanceOf(Error);
        if (scenario === "joined-send") {
          expect(error).toBeInstanceOf(PeerReceiptDeliveryError);
          expect(chain(error)).toContain(sentinel);
          expect(raw.sent.map((value) => (JSON.parse(value) as { type: string }).type)).toEqual([
            "frame",
            "joined",
          ]);
        } else {
          expect(chain(error).some((item) => item instanceof PeerReceiptDeliveryError)).toBe(false);
          if (scenario === "frame-send") expect(chain(error)).toContain(sentinel);
          else
            expect(
              chain(error).some(
                (item) => item instanceof Error && item.message === "Invalid peer frame",
              ),
            ).toBe(true);
          expect(
            raw.sent.some((value) => (JSON.parse(value) as { type: string }).type === "joined"),
          ).toBe(false);
        }
      } finally {
        raw.close();
        await outcome;
      }
    },
  );
});
