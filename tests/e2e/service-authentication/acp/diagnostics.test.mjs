import assert from "node:assert/strict";
import test from "node:test";
import { inspectLogs, redactFailure, respondToJwks } from "./diagnostics.mjs";

const runtime = "runtime-private-canary";
const workload = "gateway-private-canary";
const outgoing = "identity-private-canary";
const cct = "signed-context-private-canary";
const authentication = {
  outgoing,
  jwks: { keys: [{ kid: "public-fixture-key" }] },
};

function response() {
  return {
    status: undefined,
    body: undefined,
    writeHead(status) {
      this.status = status;
    },
    end(body) {
      this.body = body;
    },
  };
}

test("a valid JWKS request keeps its public response", () => {
  const output = response();
  const failures = [];
  respondToJwks(
    { headers: { "antnest-service-authorization": `Bearer ${outgoing}` } },
    output,
    authentication,
    failures,
  );
  assert.equal(output.status, 200);
  assert.deepEqual(JSON.parse(output.body), authentication.jwks);
  assert.deepEqual(failures, []);
});

for (const [name, headers] of [
  ["wrong workload", { "antnest-service-authorization": `Bearer ${workload}` }],
  ["missing workload", {}],
  [
    "caller context leak",
    {
      "antnest-service-authorization": `Bearer ${outgoing}`,
      "antnest-caller-context": cct,
    },
  ],
]) {
  test(`${name} is reported without escaping the event listener cleanup boundary`, () => {
    const output = response();
    const failures = [];
    assert.doesNotThrow(() =>
      respondToJwks({ headers }, output, authentication, failures),
    );
    assert.equal(output.status, 503);
    assert.equal(failures.length, 1);
    for (const secret of [runtime, workload, outgoing, cct]) {
      assert(!String(failures[0]).includes(secret));
      assert(!output.body.includes(secret));
    }
    assert.equal(failures[0].cause, undefined);
  });
}

test("Runtime credential log detection is retained", () => {
  assert.throws(
    () => inspectLogs(`before ${runtime} after`, runtime),
    /private authority/,
  );
});

for (const [name, secret] of [
  ["Gateway workload", workload],
  ["outgoing workload", outgoing],
  ["signed CCT", cct],
]) {
  test(`${name} must be detected in ACP logs`, () => {
    assert.throws(
      () =>
        inspectLogs(
          `before ${secret} after`,
          runtime,
          new Set([workload, outgoing, cct]),
        ),
      /private authority/,
    );
  });
}

test("public logs pass without changing the secret inventory", () => {
  const secrets = new Set([workload, outgoing, cct]);
  inspectLogs("public ACP startup", runtime, secrets);
  assert.deepEqual([...secrets], [workload, outgoing, cct]);
});

test("failure diagnostics redact nested causes and child stdout/stderr without retaining raw errors", () => {
  const child = Object.assign(
    new Error(`child ${workload}`, { cause: new Error(cct) }),
    {
      stdout: `stdout ${outgoing}`,
      stderr: `stderr ${runtime}`,
    },
  );
  const error = redactFailure(
    new AggregateError([child], "ECONNRESET"),
    new Set([runtime, workload, outgoing, cct]),
  );
  for (const secret of [runtime, workload, outgoing, cct])
    assert(!error.stack.includes(secret));
  assert.match(error.message, /ECONNRESET/);
  assert.match(error.message, /\[REDACTED\]/);
  assert.equal(error.cause, undefined);
  assert.equal(error.errors, undefined);
  assert.equal(error.stdout, undefined);
});

test("longer private values are redacted before their prefixes", () => {
  const error = redactFailure(
    new Error("prefix-private-and-suffix"),
    new Set(["prefix-private", "prefix-private-and-suffix"]),
  );
  assert(!error.message.includes("and-suffix"));
});

test("redaction occurs before the public diagnostic size limit", () => {
  const secret = "s".repeat(40_000);
  const error = redactFailure(new Error(secret), new Set([secret]));
  assert(!error.message.includes("ssss"));
  assert(error.message.length <= 16_384);
});
