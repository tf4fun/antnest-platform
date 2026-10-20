import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
const url = new URL("./skill-restore-missing-volume.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const options = () => ({
  gateway: "https://gateway.example",
  agentID: "peer",
  key: "original-enable-key",
  admin: { cookie: "original-session", csrf: "original-csrf" },
  signal: new AbortController().signal,
});
const validBody = JSON.stringify({
  code: "dependency_unavailable",
  retryable: true,
});
const response = (body = validBody, status = 503, trace = "a".repeat(32)) => ({
  status,
  headers: new Headers({ "x-antnest-trace-id": trace }),
  async text() {
    return body;
  },
});
test("Skill-restore captures the one original Enable and its unparsed 503 body before admission", async () => {
  assert.equal(typeof implementation.requestMissingSkillEnable, "function");
  const input = options();
  const calls = [];
  const receipt = await implementation.requestMissingSkillEnable(input, {
    async request(url, init) {
      calls.push({ url, init });
      return response();
    },
  });
  implementation.assertMissingSkillEnable(receipt);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, input.gateway + "/api/admin/agents/peer/enable");
  assert.equal(calls[0].init.headers["Idempotency-Key"], input.key);
  assert.equal(calls[0].init.headers.Cookie, input.admin.cookie);
  assert.equal(calls[0].init.headers["X-Antnest-CSRF-Token"], input.admin.csrf);
  assert.deepEqual(receipt.request, {
    agent_id: "peer",
    method: "POST",
    path: "/api/admin/agents/peer/enable",
    body: "{}",
    idempotency_key: input.key,
    timeout_ms: 5000,
  });
  assert.equal(receipt.raw_text, validBody);
  for (const mutate of [
    (r) => (r.status = 200),
    (r) => (r.trace_id = ""),
    (r) => (r.raw_text = "broken-json"),
    (r) =>
      (r.raw_text = JSON.stringify({
        code: "skill_preparation_unavailable",
        retryable: true,
      })),
    (r) =>
      (r.raw_text = JSON.stringify({
        code: "dependency_unavailable",
        retryable: false,
      })),
  ]) {
    const changed = structuredClone(receipt);
    mutate(changed);
    assert.throws(() => implementation.assertMissingSkillEnable(changed));
  }
});
test("Skill-restore accepts only the original timeout reason and retains every unexpected transport or body error", async () => {
  assert.equal(typeof implementation.requestMissingSkillEnable, "function");
  for (const fault of ["timeout", "forged-name", "network", "parent", "body"]) {
    const timeout = new DOMException("Enable timed out", "TimeoutError"),
      parent = new AbortController(),
      input = { ...options(), signal: parent.signal },
      original =
        fault === "forged-name"
          ? Object.assign(new Error("forged"), { name: "TimeoutError" })
          : fault === "network" || fault === "parent"
            ? new Error(fault)
            : timeout;
    if (fault === "parent") parent.abort(original);
    const receipt = await implementation.requestMissingSkillEnable(input, {
      timeout(ms) {
        assert.equal(ms, 5000);
        return AbortSignal.abort(timeout);
      },
      async request() {
        if (fault === "body")
          return {
            ...response(),
            async text() {
              throw original;
            },
          };
        throw original;
      },
    });
    assert.equal(receipt.originalError, original);
    assert(!Object.keys(receipt).includes("originalError"));
    assert(receipt.error_text.includes(original.message));
    if (fault === "timeout") {
      implementation.assertMissingSkillEnable(receipt);
      assert.equal(receipt.outcome, "timeout");
      assert.equal(receipt.status, undefined);
      assert.equal(receipt.trace_id, undefined);
    } else {
      assert.throws(
        () => implementation.assertMissingSkillEnable(receipt),
        (error) => error === original,
      );
      if (fault === "body") {
        assert.equal(receipt.status, 503);
        assert.equal(receipt.trace_id, "a".repeat(32));
        assert.equal(receipt.outcome, "body-error");
      }
    }
  }
});
test("Skill-restore binds preparation to the original scoped key and requires disabled, no Runtime and no replacement volume", async () => {
  assert.equal(typeof implementation.assertMissingSkillPreparation, "function");
  const expected = {
    organizationID: "org",
    agentID: "peer",
    key: "original-enable-key",
    workspace: "workspace-b",
    skillVolume: "skills-b",
  };
  const request_id =
    "lifecycle-" +
    createHash("sha256").update("org\0original-enable-key").digest("hex");
  const value = {
    queries: ["preparing", "retry_wait"].map((state) => ({
      request: {
        method: "GET",
        path: "/api/admin/agent-skill-preparations/by-idempotency-key",
        idempotency_key: expected.key,
      },
      status: 200,
      trace_id: "b".repeat(32),
      body: {
        request_id,
        agent_id: "peer",
        kind: "enable",
        state,
        ...(state === "retry_wait"
          ? { error_code: "skill_preparation_unavailable" }
          : {}),
      },
    })),
    agent: { agent_id: "peer", activation_state: "disabled" },
    resources: { containers: [], volumes: ["workspace-b"] },
    volume_query: { name: "skills-b", lines: [] },
  };
  implementation.assertMissingSkillPreparation(value, expected);
  for (const mutate of [
    (r) => (r.queries[0].request.idempotency_key = "other-key"),
    (r) => (r.queries[1].body.request_id = "other-request"),
    (r) => (r.queries[1].body.agent_id = "other-agent"),
    (r) => (r.queries[1].body.state = "ready"),
    (r) => (r.queries[1].body.error_code = "other-error"),
    (r) => (r.queries[0].trace_id = ""),
    (r) => (r.agent.activation_state = "enabled"),
    (r) => r.resources.containers.push("stopped-runtime"),
    (r) => r.resources.volumes.push("new-empty-volume"),
    (r) => r.volume_query.lines.push("skills-b"),
    (r) => (r.volume_query.name = "other-volume"),
  ]) {
    const changed = structuredClone(value);
    mutate(changed);
    assert.throws(() =>
      implementation.assertMissingSkillPreparation(changed, expected),
    );
  }
});
