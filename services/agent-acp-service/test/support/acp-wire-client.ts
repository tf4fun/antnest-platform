import * as v1 from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import { expect } from "vitest";
import WebSocket from "ws";

export type ProtocolVersion = 1 | 2;
export type WireFrame = {
  id?: number;
  method?: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: { code?: string; retryable?: boolean } };
  params?: { sessionId?: string; update?: Record<string, unknown> };
};

// Retain frames before issuing a request so immediate updates cannot race a
// one-shot message listener. The product still uses the official SDK codecs.
export class AcpWireClient {
  public readonly frames: WireFrame[] = [];
  private nextId = 0;
  private readonly failures: Error[] = [];

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => {
      try {
        const buffer = Array.isArray(data)
          ? Buffer.concat(data)
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : data;
        const parsed = JSON.parse(buffer.toString("utf8")) as WireFrame | WireFrame[];
        this.frames.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      } catch (error) {
        this.failures.push(new Error("Invalid server JSON", { cause: error }));
      }
    });
    socket.on("error", (error) => this.failures.push(error));
  }

  public static async connect(url: string, subject: string): Promise<AcpWireClient> {
    const socket = new WebSocket(url, {
      headers: { "x-antnest-agent-access-subject": subject },
    });
    const client = new AcpWireClient(socket);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
        socket.once("unexpected-response", (_request, response) => {
          response.destroy();
          reject(new Error(`WebSocket upgrade rejected: ${response.statusCode}`));
        });
      });
      return client;
    } catch (error) {
      socket.terminate();
      throw error;
    }
  }

  public async initialize(version: ProtocolVersion): Promise<WireFrame> {
    const params =
      version === 1
        ? { protocolVersion: v1.PROTOCOL_VERSION, clientCapabilities: {} }
        : {
            protocolVersion: v2.PROTOCOL_VERSION,
            info: { name: "boundary-test", version: "1.0.0" },
          };
    const frame = await this.request("initialize", params);
    expect(frame.error).toBeUndefined();
    return frame;
  }

  public async request(method: string, params: Record<string, unknown>): Promise<WireFrame> {
    const id = ++this.nextId;
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    await expect
      .poll(
        () => {
          const failure = this.failures[0];
          if (failure !== undefined) throw failure;
          return this.frames.some((frame) => frame.id === id);
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    const response = this.frames.find((frame) => frame.id === id);
    if (response === undefined) throw new Error(`Missing response for ${method}`);
    return response;
  }

  public notify(method: string, params: Record<string, unknown>): void {
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  public async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) => this.socket.once("close", () => resolve()));
    this.socket.terminate();
    await closed;
  }
}
