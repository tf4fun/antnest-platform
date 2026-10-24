import { createServer } from "node:net";

export type TcpPortReservation = {
  readonly port: number;
  release(): Promise<void>;
};

export async function reserveTcpPort(): Promise<TcpPortReservation> {
  // Keep the original listener alive while other fixture peers bind. A port
  // number whose listener was already closed is not a reservation.
  const server = createServer((socket) => socket.destroy());
  let closing: Promise<void> | undefined;
  const release = (): Promise<void> =>
    (closing ??= new Promise<void>((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close((error) => (error ? reject(error) : resolve()));
    }));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("No reserved port");
    return { port: address.port, release };
  } catch (error) {
    try {
      await release();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "TCP reservation startup and cleanup failed",
        { cause: cleanup },
      );
    }
    throw error;
  }
}
