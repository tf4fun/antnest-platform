import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

// Physical names from contracts/runtime/runtime-plane-limits.json. Fixture
// lookups must use the same scope as their owned Controller, including hashes.
export function runtimeResourceName(scope, kind, agent) {
  assert(typeof scope === "string" && scope.length > 0);
  assert(typeof agent === "string" && agent.length > 0);
  assert(["runtime", "workspace"].includes(kind));
  const hash = (s) =>
    "h-" + createHash("sha256").update(s).digest("hex").slice(0, 32);
  const plain = (s) =>
    /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(s) && !s.startsWith("h-");
  const ambiguous =
    /^(?:runtime|workspace)(?:-|$)|-(?:runtime|workspace)(?:-|$)/u.test(scope);
  let left = plain(scope) && !ambiguous ? scope : hash(scope);
  let right = plain(agent) ? agent : hash(agent);
  const name = () => `antnest-${left}-${kind}-${right}`;
  if (Buffer.byteLength(name()) > 128) left = hash(scope);
  if (Buffer.byteLength(name()) > 128) right = hash(agent);
  assert(Buffer.byteLength(name()) <= 128);
  return name();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.stdout.write(runtimeResourceName(...process.argv.slice(2)));
