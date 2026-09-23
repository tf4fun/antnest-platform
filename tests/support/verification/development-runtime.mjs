import assert from "node:assert/strict";

export function inspectDevelopmentRuntime(
  rows,
  { name, agentId, scope, volume },
) {
  assert.equal(rows.length, 1, "one Runtime inspection required");
  const row = rows[0];
  assert.match(row.Id, /^[a-f0-9]{64}$/u, "full Runtime container ID required");
  assert.equal(row.Name, "/" + name, "Runtime name mismatch");
  const labels = row.Config?.Labels;
  assert.equal(
    labels?.["io.antnest.agent-id"],
    agentId,
    "Runtime Agent mismatch",
  );
  assert.equal(labels?.["io.antnest.managed"], "runtime", "unmanaged Runtime");
  assert.equal(
    labels?.["io.antnest.runtime-controller-scope"],
    scope,
    "Runtime scope mismatch",
  );
  assert(Array.isArray(row.Mounts), "Runtime mounts missing");
  assert(
    !Object.keys(row.HostConfig?.Tmpfs ?? {}).some(
      (path) => path === "/workspace" || path.startsWith("/workspace/"),
    ),
    "nested mounts shadow the workspace",
  );
  assert(
    !row.Mounts.some((m) => m.Destination?.startsWith("/workspace/")),
    "nested mounts shadow the workspace",
  );
  const mounts = row.Mounts.filter((m) => m.Destination === "/workspace");
  assert.equal(mounts.length, 1, "one complete workspace mount required");
  assert.equal(mounts[0].Type, "volume", "workspace must be a named volume");
  assert.equal(mounts[0].RW, true, "workspace must be writable");
  assert.equal(mounts[0].Name, volume, "workspace volume mismatch");
  return row;
}

// Resolve the actual target inside the immutable owned Runtime before reading or writing.
const resolveWorkspaceFile = `resolved=$(readlink -f "$1") || exit
case "$resolved" in /workspace/*) ;; *) exit 1;; esac
case "$resolved" in */.cache|*/.cache/*) exit 1;; esac`;
export const readWorkspaceFile = resolveWorkspaceFile + '\ncat -- "$resolved"';
export const writeWorkspaceFile =
  resolveWorkspaceFile + '\nprintf %s "$2" > "$resolved"';
