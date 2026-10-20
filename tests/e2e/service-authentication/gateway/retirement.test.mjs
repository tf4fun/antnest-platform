import assert from "node:assert/strict";
import test from "node:test";
import { assertRejection } from "./retirement.mjs";

const publicBody = JSON.stringify({
  code: "not_found",
  message: "Resource was not found",
});
const secret = "private-retirement-fixture-canary";

test("retirement evidence accepts only the complete public rejection", () => {
  assertRejection(404, {}, publicBody, "GET");
  assertRejection(404, {}, "", "HEAD");
  assertRejection(
    403,
    {},
    JSON.stringify({
      code: "forbidden",
      message: "Request origin is not allowed",
    }),
    "POST",
    403,
  );
});

test("retirement evidence rejects leaked or malformed responses without echoing them", async (t) => {
  for (const [name, headers, body, method = "GET"] of [
    ...[
      "set-cookie",
      "antnest-service-authorization",
      "antnest-caller-context",
    ].map((name) => [name, { [name]: secret }, publicBody]),
    [
      "extra credential",
      {},
      JSON.stringify({
        code: "not_found",
        message: "Resource was not found",
        access_token: secret,
      }),
    ],
    ["malformed JSON", {}, secret],
    [
      "duplicate code hides private data",
      {},
      `{"code":"${secret}","code":"not_found","message":"Resource was not found"}`,
    ],
    [
      "duplicate message hides private data",
      {},
      `{"code":"not_found","message":"${secret}","message":"Resource was not found"}`,
    ],
    [
      "wrong code",
      {},
      JSON.stringify({ code: secret, message: "Resource was not found" }),
    ],
    [
      "wrong message",
      {},
      JSON.stringify({ code: "not_found", message: secret }),
    ],
    ["HEAD body", {}, secret, "HEAD"],
    ["null", {}, "null"],
    ["array", {}, "[]"],
  ]) {
    await t.test(name, () => {
      assert.throws(
        () => assertRejection(404, headers, body, method),
        (error) => {
          assert(
            !String(error).includes(secret),
            "inspector printed the private canary",
          );
          assert(
            !JSON.stringify(error).includes(secret),
            "assertion metadata retained the private canary",
          );
          return true;
        },
      );
    });
  }
});
