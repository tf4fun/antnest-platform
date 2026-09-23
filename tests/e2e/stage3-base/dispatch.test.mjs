import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const entry = fileURLToPath(new URL("../e2e-stage3a.sh", import.meta.url));
const source = await readFile(entry, "utf8");
const boundary = source.indexOf("runtime_image=$(docker image inspect");
assert(boundary > 0);
for (const [flag, profile, suite] of [
  [null, "stage3-base", ""],
  ["TOOL_PERMISSIONS", "tool-permissions", ""],
  ["TOOL_PROGRESS", "tool-progress", ""],
  ["FILE_OBSERVATIONS", "file-observations", ""],
  ["STRUCTURED_PLAN", "structured-plan", ""],
  ["SLASH_COMMANDS", "slash-commands", ""],
  ["MULTIMODAL", "multimodal", ""],
  ["SESSION_COST", "session-cost", ""],
  ["RPC_RESPONSE_LOSS", "rpc-response-loss", ""],
  ["ACP_PERSISTENCE", "acp-persistence", ""],
  ["ACP_RESTART", "acp-restart", ""],
  ["MANAGED_MCP", "managed-mcp", ""],
  ["IDENTITY_CORE", "identity-http", "core"],
  ["IDENTITY_ACCESS", "identity-http", "access"],
  ["ACP_SESSION", "acp-session", ""],
  ["AGENT_ACCESS", "agent-access", ""],
  ["ACP_CLOSEOUT", "acp-closeout", ""],
])
  test(`Stage 3 dispatch selects migrated ${flag ?? "default"} before Docker setup`, () => {
    // Exercise actual shell flag selection; stop before any Docker invocation.
    const result = spawnSync(
      "/bin/sh",
      [
        "-c",
        `
      node() {
        case "$1" in
          tests/support/verification/stage3-storage.mjs) "$DISPATCH_NODE" "$@" ;;
          tests/e2e/acp-closeout/network.mjs|-e) printf '1' ;;
          *) echo "unexpected Node entry: $1" >&2; return 73 ;;
        esac
      }
      ${source.slice(0, boundary)}
      printf '%s:%s' "$tool_profile" "${"${ANTNEST_IDENTITY_SUITE:-}"}"
    `,
        entry,
      ],
      {
        env: {
          PATH: "/usr/bin:/bin",
          DISPATCH_NODE: process.execPath,
          ...(flag ? { [`ANTNEST_E2E_${flag}`]: "true" } : {}),
        },
        encoding: "utf8",
        timeout: 5000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${profile}:${suite}`);
  });
