import { createServer, type Server } from "node:net";
import { describe, expect, it } from "vitest";
import { reserveTcpPort } from "./reserved-tcp-port.js";

type Reservation = Awaited<ReturnType<typeof reserveTcpPort>>;

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected an original TCP listener address");
  return address.port;
}

async function withTcpResources(
  operation: (fixture: {
    reserve: () => Promise<Reservation>;
    listen: (port?: number) => Promise<Server>;
  }) => Promise<void>,
): Promise<void> {
  const reservations: Reservation[] = [];
  const servers: Server[] = [];
  const originals: Promise<void>[] = [];
  const failures: unknown[] = [];
  const reserve = async (): Promise<Reservation> => {
    const reservation = await reserveTcpPort();
    reservations.push(reservation);
    return reservation;
  };
  const listen = async (port = 0): Promise<Server> => {
    const server = createServer();
    servers.push(server);
    const original = new Promise<void>((resolve, reject) => {
      const listening = (): void => {
        server.off("error", failed);
        resolve();
      };
      const failed = (error: Error): void => {
        server.off("listening", listening);
        reject(error);
      };
      server.once("listening", listening);
      server.once("error", failed);
      try {
        server.listen({ host: "127.0.0.1", port });
      } catch (error) {
        server.off("listening", listening);
        server.off("error", failed);
        reject(
          error instanceof Error
            ? error
            : new Error("TCP listener startup failed", { cause: error }),
        );
      }
    });
    originals.push(original);
    await original;
    return server;
  };
  try {
    await operation({ reserve, listen });
  } catch (error) {
    failures.push(error);
  } finally {
    // Failed binds have their original error asserted by each case. Join them
    // alongside successful listens before closing every owned live listener.
    await Promise.allSettled(originals);
    const cleanup = await Promise.allSettled([
      ...reservations.map((reservation) => reservation.release()),
      ...servers.map((server) => {
        if (!server.listening) return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }),
    ]);
    for (const outcome of cleanup)
      if (outcome.status === "rejected") failures.push(outcome.reason);
    for (const server of servers)
      if (server.listening || server.address() !== null)
        failures.push(new Error("Original TCP probe listener did not close"));
  }
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      "TCP reservation business or original cleanup failed",
    );
}

describe("reserved TCP ports", () => {
  it("holds the original listener until release instead of returning an already free port", async () => {
    await withTcpResources(async ({ reserve, listen }) => {
      const reservation = await reserve();
      expect(Number.isInteger(reservation.port)).toBe(true);
      expect(reservation.port).toBeGreaterThan(0);
      expect(reservation.port).toBeLessThanOrEqual(65_535);
      await expect(listen(reservation.port)).rejects.toMatchObject({
        code: "EADDRINUSE",
      });
      await reservation.release();
      const replacement = await listen(reservation.port);
      expect(portOf(replacement)).toBe(reservation.port);
    });
  });

  it("keeps eight reservations distinct and releases only the selected port", async () => {
    await withTcpResources(async ({ reserve, listen }) => {
      const reservations: Reservation[] = [];
      for (let index = 0; index < 8; index += 1)
        reservations.push(await reserve());
      const ports = reservations.map((reservation) => reservation.port);
      expect(new Set(ports).size).toBe(8);
      const extra = await listen();
      expect(ports).not.toContain(portOf(extra));

      const released = reservations[3]!;
      await released.release();
      const replacement = await listen(released.port);
      expect(portOf(replacement)).toBe(released.port);
      for (const reservation of reservations)
        if (reservation !== released)
          await expect(listen(reservation.port)).rejects.toMatchObject({
            code: "EADDRINUSE",
          });
      expect(replacement.listening).toBe(true);
      expect(extra.listening).toBe(true);
    });
  });

  it("returns the same original close Promise and cannot close a later owner of that port", async () => {
    await withTcpResources(async ({ reserve, listen }) => {
      const reservation = await reserve();
      const originalClose = reservation.release();
      const repeatedClose = reservation.release();
      expect(repeatedClose).toBe(originalClose);
      await originalClose;

      const replacement = await listen(reservation.port);
      const lateClose = reservation.release();
      expect(lateClose).toBe(originalClose);
      await lateClose;
      expect(replacement.listening).toBe(true);
      expect(portOf(replacement)).toBe(reservation.port);
      await expect(listen(reservation.port)).rejects.toMatchObject({
        code: "EADDRINUSE",
      });
      expect(replacement.listening).toBe(true);
    });
  });
});
