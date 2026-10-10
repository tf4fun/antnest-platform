import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Execute the real container entrypoint. Only its Gateway/ACP peers and clock
// are replaced, so the regression checks admission before the actual Prompt.
const gatewayPeer = `
  export class GatewayClient {
    cookie = "fixture-cookie";
    async request(path, options = {}) {
      const f = globalThis.fixture;
      if (path === "/api/session/login") return {body: {}};
      if (path.endsWith("/state")) {
        f.events.push("state");
        f.reads++;
        f.timeouts.push(options.timeoutMs);
        if (f.mode === "http-error") throw new Error("state HTTP 503");
        const ready = ["ready", "prompt-failure", "new-failure", "ready-with-reason", "ready-with-session", "bad-revision", "late-ready"].includes(f.mode) ||
          (f.mode === "delayed" && f.reads === 3) ||
          (f.mode === "near-deadline" && f.reads === 2);
        if (f.mode === "late-ready") f.now += 90000;
        if (f.mode === "near-deadline" && f.reads === 1) f.now += 89700;
        f.ready = ready;
        return {body: {
          agent_id: f.mode === "wrong-agent" ? "agent_other" : "agent_target",
          access_allowed: f.mode !== "denied",
          availability: ready ? "ready" : f.mode === "busy" ? "busy" : "offline",
          active_session_id: ["busy", "ready-with-session"].includes(f.mode) ? "session_other" : null,
          configuration_revision: f.mode === "denied" ? null : f.mode === "bad-revision" ? "malformed" : "a".repeat(64),
          unavailable_reason: f.mode === "ready-with-reason" ? "agent_unavailable" : ready ? null : f.mode === "denied" ? "access_denied" :
            f.mode === "barrier" ? "runtime_barrier_required" : "agent_unavailable"
        }};
      }
      if (path.includes("/view?")) return {body: {systemNotices: []}};
      throw new Error("unexpected Gateway request: " + path);
    }
  }
`;
const acpPeer = `
  export function connectACP() {
    const f = globalThis.fixture;
    f.events.push("connect");
    return {
      updates: ["Find Skill", "Load Skill"].map(title => ({
        update: {sessionUpdate: "tool_call", title}
      })),
      async initialize() { f.events.push("initialize"); },
      async request(method) {
        f.events.push(method);
        if (method === "new") {
          if (f.mode === "new-failure") throw Object.assign(new Error("agent_unavailable"), {
            data: {code: "agent_unavailable", retryable: false}
          });
          return {sessionId: "session_fixture"};
        }
        if (method === "prompt") {
          if (!f.ready || f.mode === "prompt-failure")
            throw Object.assign(new Error("agent_unavailable"), {
              data: {code: "agent_unavailable", retryable: false}
            });
          return {stopReason: "end_turn"};
        }
        throw new Error("unexpected ACP method: " + method);
      },
      async close() { f.events.push("close"); }
    };
  }
`;

function launch(mode) {
  const replacements = {
    [new URL("../identity-closeout/support.mjs", import.meta.url).href]:
      gatewayPeer,
    [new URL("../identity-closeout/acp-connection.mjs", import.meta.url).href]:
      acpPeer,
    "node:timers/promises":
      "export async function setTimeout(ms) { globalThis.fixture.now += ms; }",
  };
  const preload = `
    import { registerHooks } from "node:module";
    globalThis.fixture = {mode: ${JSON.stringify(mode)}, now: 0, reads: 0, ready: false, events: [], timeouts: []};
    Date.now = () => globalThis.fixture.now;
    globalThis.fetch = () => { throw new Error("unexpected real network call"); };
    const replacements = ${JSON.stringify(replacements)};
    registerHooks({resolve(specifier, context, next) {
      const result = next(specifier, context);
      return replacements[result.url] === undefined ? result : {
        url: "data:text/javascript," + encodeURIComponent(replacements[result.url]), shortCircuit: true
      };
    }});
    process.on("exit", () => process.stderr.write("fixture:" + JSON.stringify(globalThis.fixture) + "\\n"));
  `;
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "data:text/javascript," + encodeURIComponent(preload),
      fileURLToPath(new URL("./discovery-tools-client.mjs", import.meta.url)),
    ],
    {
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...process.env,
        ANTNEST_E2E_AGENT_ID: "agent_target",
        ANTNEST_E2E_SOURCE_AGENT_ID: "agent_source",
      },
    },
  );
  assert.ifError(result.error);
  assert.doesNotMatch(
    result.stderr,
    /ERR_MODULE_NOT_FOUND|does not provide an export|SyntaxError/,
  );
  const record = result.stderr
    .split("\n")
    .find((line) => line.startsWith("fixture:"));
  assert(record, result.stderr);
  const diagnostic = result.stderr
    .split("\n")
    .find((line) => line.startsWith('{"status":"discovery_tools_failed"'));
  return {
    ...result,
    fixture: JSON.parse(record.slice("fixture:".length)),
    diagnostic: diagnostic && JSON.parse(diagnostic),
  };
}

test("discovery waits for ACP publication after Controller readiness before its first Prompt", () => {
  const result = launch("delayed");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.fixture.events, [
    "state",
    "state",
    "state",
    "connect",
    "initialize",
    "new",
    "prompt",
    "close",
  ]);
  assert.equal(result.fixture.now, 500);
  assert.deepEqual(result.fixture.timeouts, [15000, 15000, 15000]);
  assert.equal(
    JSON.parse(result.stdout.trim()).status,
    "model_discovery_guidance_loaded",
  );
});

test("already published ACP needs one read and one Prompt", () => {
  const result = launch("ready");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.fixture.reads, 1);
  assert.equal(result.fixture.now, 0);
  assert.equal(
    result.fixture.events.filter((event) => event === "prompt").length,
    1,
  );
});

test("publication that never arrives fails within 90 seconds without opening ACP", () => {
  const result = launch("offline");
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /target Agent execution readiness: deadline exceeded/,
  );
  assert.equal(result.fixture.now, 90000);
  assert.equal(result.fixture.reads, 360);
  assert(result.fixture.events.every((event) => event === "state"));
});

test("the next state request is clipped to the remaining readiness deadline", () => {
  const result = launch("near-deadline");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.fixture.reads, 2);
  assert.deepEqual(result.fixture.timeouts, [15000, 50]);
  assert.equal(result.fixture.now, 89950);
});

for (const mode of [
  "denied",
  "wrong-agent",
  "busy",
  "barrier",
  "http-error",
  "ready-with-reason",
  "ready-with-session",
  "bad-revision",
])
  test(`discovery does not retry ${mode} or open an ACP session`, () => {
    const result = launch(mode);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.fixture.events, ["state"]);
    assert.equal(result.fixture.now, 0);
    assert.equal(result.diagnostic?.stage, "execution-readiness");
  });

test("a ready response arriving after the readiness deadline cannot open ACP", () => {
  const result = launch("late-ready");
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /target Agent execution readiness: deadline exceeded/,
  );
  assert.deepEqual(result.fixture.events, ["state"]);
});

test("a Prompt rejected after ready is not retried and its connection is closed", () => {
  const result = launch("prompt-failure");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /agent_unavailable/);
  assert.equal(result.fixture.reads, 1);
  assert.equal(
    result.fixture.events.filter((event) => event === "prompt").length,
    1,
  );
  assert.equal(result.fixture.events.at(-1), "close");
  assert.equal(result.diagnostic?.stage, "session/prompt");
  assert.equal(
    result.diagnostic?.last_state.configuration_revision,
    "a".repeat(64),
  );
});

test("session/new rejected after ready is not retried and its connection is closed", () => {
  const result = launch("new-failure");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /agent_unavailable/);
  assert.equal(result.fixture.reads, 1);
  assert.deepEqual(result.fixture.events, [
    "state",
    "connect",
    "initialize",
    "new",
    "close",
  ]);
  assert.equal(result.diagnostic?.stage, "session/new");
});
