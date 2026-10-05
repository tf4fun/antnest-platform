import { writeFileSync } from "node:fs";

// A controllable noninteractive OpenSSL stand-in for cancellation only.
// It never parses keys or signs a certificate; positive tests use real OpenSSL.
writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid }), {
  mode: 0o600,
  flag: "wx",
});
const timer = setInterval(() => {}, 1000);
process.once("SIGTERM", () => {
  clearInterval(timer);
});
