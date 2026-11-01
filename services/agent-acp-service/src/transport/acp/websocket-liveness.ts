import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";

export function startWebSocketLiveness(socket: WebSocket, intervalMs = 20_000): () => void {
  if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 300_000)
    throw new Error("WebSocket liveness interval must be an integer from 1 to 300000");
  const pending = new Set<Buffer>();
  let stopped = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const terminate = () => {
    socket.terminate();
    stop();
  };
  const armDeadline = () => {
    clearTimeout(deadline);
    deadline = setTimeout(terminate, intervalMs * 2);
    deadline.unref();
  };
  const onPong = (data: Buffer) => {
    for (const nonce of pending) {
      if (!data.equals(nonce)) continue;
      pending.delete(nonce);
      armDeadline();
      return;
    }
  };
  const onClose = () => stop();
  const onError = () => terminate();
  const ping = setInterval(() => {
    const nonce = randomBytes(16);
    try {
      socket.ping(nonce);
    } catch {
      terminate();
      return;
    }
    pending.add(nonce);
    if (pending.size > 2) pending.delete(pending.values().next().value!);
  }, intervalMs);
  ping.unref();
  armDeadline();
  socket.on("pong", onPong);
  socket.once("close", onClose);
  socket.once("error", onError);
  function stop() {
    if (stopped) return;
    stopped = true;
    pending.clear();
    clearInterval(ping);
    clearTimeout(deadline);
    socket.off("pong", onPong);
    socket.off("close", onClose);
    socket.off("error", onError);
  }
  return stop;
}
