import { setTimeout as delay } from "node:timers/promises";

export async function until(probe, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
