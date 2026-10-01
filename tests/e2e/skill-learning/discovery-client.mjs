import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { until } from "../workspace-closeout/c4-setup.mjs";

const org = process.env.ANTNEST_E2E_ORG_ID;
const actor = process.env.ANTNEST_E2E_ACTOR_ID;
const agent = process.env.ANTNEST_E2E_AGENT_ID;
const phase = process.env.ANTNEST_E2E_DISCOVERY_PHASE;
const propagation = process.env.ANTNEST_E2E_SKILL_PROPAGATION === "true";
const old = process.env.ANTNEST_E2E_DISCOVERY_PREVIOUS
  ? JSON.parse(process.env.ANTNEST_E2E_DISCOVERY_PREVIOUS)
  : null;
assert(/^org_[0-9a-f]{32}$/u.test(org));
assert(/^user_[0-9a-f]{32}$/u.test(actor));
assert(/^agent_[0-9a-f]{32}$/u.test(agent));
const registryToken = process.env.ANTNEST_E2E_SKILL_REGISTRY_TOKEN;
const sourceToken = process.env.ANTNEST_E2E_SKILL_SOURCE_TOKEN;
assert(registryToken && sourceToken);
async function call(path, value, status = 200, source = false) {
  const response = await fetch(
    `http://${source ? "agent-acp-service" : "skill-registry"}:8080${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${source ? sourceToken : registryToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(value),
      signal: AbortSignal.timeout(12000),
    },
  );
  assert.equal(
    response.status,
    status,
    `${path} ${await (response.status === status ? Promise.resolve("") : response.text())}`,
  );
  if (response.headers.get("content-type") === "application/zip") {
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    assert.equal(response.headers.get("content-length"), String(bytes.length));
    assert.equal(response.headers.get("x-antnest-artifact-digest"), digest);
    assert.equal(response.headers.get("etag"), `"${digest}"`);
    assert.equal(
      response.headers.get("x-antnest-content-digest"),
      value.expected_digest,
    );
    return bytes;
  }
  return response.json();
}
const search = async () => {
  const page = await call("/internal/skill-discovery/search", {
    organization_id: org,
    actor_id: actor,
    query: "fixture-procedure",
  });
  return page.items.find(
    (s) => s.skill_ref.kind === "agent" && s.skill_ref.agent_id === agent,
  );
};
const loadInput = (item) => ({
  organization_id: org,
  actor_id: actor,
  skill_ref: item.skill_ref,
  expected_digest: item.content_digest,
});
let result;
if (phase === "create" || phase === "update") {
  const sequence = phase === "create" ? 1 : 2;
  const item = await until(
    async () => {
      try {
        const found = await search();
        return found?.skill_ref.sequence === sequence ? found : null;
      } catch {
        return null;
      }
    },
    `automatic projection ${sequence}`,
    undefined,
    90000,
  );
  const input = loadInput(item);
  const fromRegistry = await call("/internal/skill-discovery/load", input);
  const fromAgent = await call(
    "/internal/skill-sources/artifact",
    input,
    200,
    true,
  );
  assert.deepEqual(fromRegistry, fromAgent);
  const denied = await call(
    "/internal/skill-sources/artifact",
    { ...input, actor_id: `user_${"f".repeat(32)}` },
    404,
    true,
  );
  assert.equal(denied.error.code, "not_found");
  if (old)
    assert.equal(
      (await call("/internal/skill-discovery/load", loadInput(old.item), 409))
        .error.code,
      "content_changed",
    );
  let formal;
  if (phase === "update" && !propagation) {
    formal = await call(
      "/internal/skill-projections/promote",
      { request_id: "source-e2e-promote", ...input },
      201,
    );
    assert.equal(formal.content_digest, item.content_digest);
  }
  result = { phase, item, bytes: fromAgent.length, formal };
} else if (phase === "disabled" || phase === "enabled" || phase === "deleted") {
  assert(old?.item && old.formal);
  const input = loadInput(old.item);
  if (phase === "enabled") {
    const item = await until(
      async () => {
        try {
          const current = await search();
          return current?.skill_ref.sequence === old.item.skill_ref.sequence
            ? current
            : null;
        } catch {
          return null;
        }
      },
      "unchanged managed source readable after normal Enable",
      undefined,
      90000,
    );
    assert.deepEqual(item, old.item);
    const fromRegistry = await call("/internal/skill-discovery/load", input);
    const fromAgent = await call(
      "/internal/skill-sources/artifact",
      input,
      200,
      true,
    );
    assert.deepEqual(fromRegistry, fromAgent);
    assert.equal(fromAgent.length, old.bytes);
    result = { phase, item, bytes: fromAgent.length };
  } else {
    const status = phase === "disabled" ? 503 : 404;
    const code = phase === "disabled" ? "source_unavailable" : "not_found";
    assert.equal(
      (await call("/internal/skill-sources/artifact", input, status, true))
        .error.code,
      code,
    );
    assert.equal(
      (await call("/internal/skill-discovery/load", input, status)).error.code,
      code,
    );
    if (phase === "disabled") {
      assert.equal(
        (
          await call(
            "/internal/skill-discovery/search",
            {
              organization_id: org,
              actor_id: actor,
              query: "fixture-procedure",
            },
            503,
          )
        ).error.code,
        "source_unavailable",
      );
    } else assert.equal(await search(), undefined);
    result = { phase, source_status: status, source_code: code };
  }
  const bytes = await call("/internal/skill-discovery/load", {
    organization_id: org,
    actor_id: actor,
    skill_ref: {
      kind: "registry",
      skill_id: old.formal.skill_id,
      version: old.formal.version,
    },
    expected_digest: old.formal.content_digest,
  });
  assert.equal(bytes.length, old.bytes);
  result.formal = old.formal;
} else if (phase === "changed") {
  assert(old?.item && old.formal);
  assert.equal(
    (
      await call(
        "/internal/skill-sources/artifact",
        loadInput(old.item),
        409,
        true,
      )
    ).error.code,
    "content_changed",
  );
  assert.equal(
    (await call("/internal/skill-discovery/load", loadInput(old.item), 404))
      .error.code,
    "not_found",
  );
  const formalInput = {
    organization_id: org,
    actor_id: actor,
    skill_ref: {
      kind: "registry",
      skill_id: old.formal.skill_id,
      version: old.formal.version,
    },
    expected_digest: old.formal.content_digest,
  };
  const bytes = await call("/internal/skill-discovery/load", formalInput);
  assert.equal(bytes.length, old.bytes);
  if (!propagation)
    assert.deepEqual(
      await call(
        "/internal/skill-projections/promote",
        { request_id: "source-e2e-promote", ...loadInput(old.item) },
        201,
      ),
      old.formal,
    );
  result = { phase, formal: old.formal, bytes: bytes.length };
} else throw new Error("Unknown discovery fixture phase");
console.log(JSON.stringify(result));
