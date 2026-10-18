import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire, registerHooks } from "node:module";
import {
  commandFixture,
  setup,
  principal,
} from "../acp-commands/connection.fixture.mjs";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const ajvPath = require.resolve("ajv/dist/2020.js");
registerHooks({
  resolve(specifier, context, next) {
    return specifier === "ajv/dist/2020.js"
      ? next(ajvPath, context)
      : next(specifier, context);
  },
});
const url = new URL("./private-access.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});

for (const version of [1, 2])
  test(`Managed v${version} host delegates the original Session with two grants and exports a real CLIENT`, async (t) => {
    assert.equal(typeof implementation.createManagedPrivateAccess, "function");
    const profile = { name: `managed-v${version}`, version };
    const f = await commandFixture(t, profile);
    const directory = await mkdtemp(join(tmpdir(), "managed-private-access-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    for (const [path, value] of [
      ["edge-gateway/tokens/identity-service", "G"],
      ["agent-ui/tokens/agent-acp-service", "W"],
    ]) {
      await mkdir(join(directory, path, ".."), { recursive: true });
      await writeFile(join(directory, path), value.repeat(43), { mode: 0o600 });
    }
    const origin = new URL(f.endpoint).origin;
    const saved = [];
    const access = implementation.createManagedPrivateAccess({
      env: {
        TEST_DOCKER_PROJECT: "owned-project",
        TEST_MANAGED_CREDENTIAL_DIRECTORY: directory,
        TEST_ACP_ORIGIN: origin,
        TEST_IDENTITY_ORIGIN: origin,
        TEST_OTLP_ENDPOINT: origin + "/v1/traces",
      },
      secrets: f.secrets,
      preserveConnection: async (index, snapshot) =>
        saved.push({ index, snapshot: structuredClone(snapshot) }),
    });
    t.after(() => access.telemetry.shutdown());
    const c = f.register(
      await access.open(profile, "agent", f.browser, principal),
    );
    const result = await c.request("new", setup);
    await c.closeAndWait();
    await access.telemetry.flush();
    assert.deepEqual(
      f.calls.map((x) => x.method),
      ["initialize", "session/new"],
    );
    assert.deepEqual(
      f.identities.map((x) => x.body),
      [
        {
          access_token: f.browser.accessToken,
          profile: "workspace",
          agent_id: "agent",
        },
      ],
    );
    assert.equal(
      f.identities[0].headers["antnest-service-authorization"],
      `Bearer ${"G".repeat(43)}`,
    );
    assert.equal(f.wire[0].headers.cookie, undefined);
    assert.equal(
      f.wire[0].headers["antnest-service-authorization"],
      `Bearer ${"W".repeat(43)}`,
    );
    assert(f.contexts.has(f.wire[0].headers["antnest-caller-context"]));
    assert.equal(saved.at(-1).snapshot.closed, true);
    assert.equal(saved.at(-1).snapshot.initialization.method, "initialize");
    assert.equal(
      saved.at(-1).snapshot.evidence[0].requestReceipt.result.sessionId,
      result.sessionId,
    );
    const [span] = f.spans();
    assert.equal(span.spanId, c.clientSpanID);
    assert.equal(span.traceId, c.connectionTraceID);
    assert.equal(span.attributes["http.response.status_code"], 101);
  });

test("Managed host access rejects incomplete or non-loopback endpoints before reading grants", () => {
  assert.equal(typeof implementation.createManagedPrivateAccess, "function");
  const valid = {
    TEST_DOCKER_PROJECT: "owned-project",
    TEST_MANAGED_CREDENTIAL_DIRECTORY: "/missing",
    TEST_ACP_ORIGIN: "http://127.0.0.1:18081",
    TEST_IDENTITY_ORIGIN: "http://127.0.0.1:18082",
    TEST_OTLP_ENDPOINT: "http://127.0.0.1:14318/v1/traces",
  };
  for (const [key, values] of Object.entries({
    TEST_ACP_ORIGIN: [
      undefined,
      "http://0.0.0.0:8080",
      "http://127.0.0.1:8080/v1/acp",
      "http://user:secret@127.0.0.1:8080",
    ],
    TEST_IDENTITY_ORIGIN: [undefined, "https://example.com"],
    TEST_OTLP_ENDPOINT: [
      undefined,
      "http://127.0.0.1:4318/",
      "http://127.0.0.1:4318/v1/traces?token=secret",
    ],
  }))
    for (const value of values)
      assert.throws(() =>
        implementation.createManagedPrivateAccess({
          env: { ...valid, [key]: value },
          secrets: [],
          preserveConnection() {},
        }),
      );
});
