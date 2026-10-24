import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { PeerSocket } from "../../src/transport/peer-socket.js";

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
});
