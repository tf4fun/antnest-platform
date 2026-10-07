import { readFileSync } from "node:fs";

// Maps each service name to the last octet of its private listener address in
// compose.yaml. agent-acp-service's control listener is named agent-acp-control.
export function composeListeners(
  compose = new URL("../../compose.yaml", import.meta.url),
) {
  const expected = new Map();
  let service;
  for (const line of readFileSync(compose, "utf8").split("\n")) {
    const header = /^ {2}([a-z][a-z-]*):$/u.exec(line);
    if (header) service = header[1];
    const listener =
      /^ {6}ANTNEST_([A-Z_]+)_LISTEN: \$\{ANTNEST_SERVICE_NETWORK_PREFIX:-10\.241\.0\}\.(\d+):\d+$/u.exec(
        line,
      );
    if (!listener) continue;
    const name = listener[1] === "ACP_CONTROL" ? "agent-acp-control" : service;
    expected.set(name, listener[2]);
  }
  return expected;
}
