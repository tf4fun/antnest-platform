import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import {
  assertSecretFree,
  inspectResponse,
  redactSecrets,
} from "./response.mjs";

const secret = "private-controller-response-canary";
function response(
  body,
  { headers = {}, status = 403, expectedStatus = status, ...options } = {},
) {
  return inspectResponse({
    response: new Response(body, {
      status,
      headers: { "content-type": "application/json", ...headers },
    }),
    text: body,
    status: expectedStatus,
    code: "caller_not_allowed",
    label: "POST /rpc/agent-controller/list-workspace-agents",
    secrets: [secret],
    ...options,
  });
}

test("Controller response inspection preserves public error and workspace data", () => {
  assert.deepEqual(response('{"code":"caller_not_allowed"}'), {
    code: "caller_not_allowed",
  });
  assert.deepEqual(
    response('{"agents":[]}', { status: 200, code: undefined }),
    { agents: [] },
  );
});

test("Controller response inspection preserves empty and non-JSON responses", () => {
  assert.equal(response("", { code: undefined }), null);
  assert.equal(
    response("healthy", {
      code: undefined,
      headers: { "content-type": "text/plain" },
    }),
    null,
  );
});

for (const [name, body, options] of [
  ["known credential in error code", JSON.stringify({ code: secret }), {}],
  [
    "known credential in public body",
    JSON.stringify({ code: "caller_not_allowed", extra: secret }),
    {},
  ],
  [
    "known credential in CCT header",
    '{"code":"caller_not_allowed"}',
    { headers: { "Antnest-Caller-Context": secret } },
  ],
  [
    "unknown credential in CCT header",
    '{"code":"caller_not_allowed"}',
    { secrets: [], headers: { "Antnest-Caller-Context": secret } },
  ],
  [
    "malformed JSON without expected code",
    secret,
    { secrets: [], code: undefined },
  ],
  ["malformed JSON with expected code", secret, { secrets: [] }],
  [
    "unknown upstream error code",
    JSON.stringify({ code: secret }),
    { secrets: [] },
  ],
  [
    "status mismatch with private body",
    secret,
    { status: 500, expectedStatus: 403, secrets: [] },
  ],
]) {
  test(`Controller ${name} fails without exposing response data`, () => {
    assert.throws(
      () => response(body, options),
      (error) => {
        assert(
          !inspect(error).includes(secret.slice(0, 8)),
          "diagnostic exposed private data",
        );
        assert(
          !JSON.stringify(error).includes(secret.slice(0, 8)),
          "serialized diagnostic exposed private data",
        );
        return true;
      },
    );
  });
}

test("Controller logs reject every recorded CCT without exposing it", () => {
  const contexts = [secret, "second-private-workspace-context"];
  for (const context of contexts)
    assert.throws(
      () =>
        assertSecretFree(
          `received ${context}`,
          contexts,
          "private credential in logs",
        ),
      (error) => !inspect(error).includes(context),
    );
  assertSecretFree(
    "safe lifecycle diagnostic",
    contexts,
    "private credential in logs",
  );
});

test("Controller failure logs redact repeated and overlapping credentials", () => {
  const contexts = [
    secret,
    `${secret}-longer-context`,
    "other-private-context",
  ];
  assert.equal(
    redactSecrets(
      `first ${contexts[1]}\nsecond ${contexts[2]}\nagain ${contexts[1]}`,
      contexts,
    ),
    "first [redacted]\nsecond [redacted]\nagain [redacted]",
  );
});
