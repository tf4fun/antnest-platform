import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

async function helper() {
  const file = new URL("./json-rpc-security.mjs", import.meta.url);
  assert(existsSync(file), "missing shared JSON media-type security probe");
  return import(file.href);
}

test("the shared media-type probe preserves valid caller credentials", async () => {
  const { assertJsonRpcContentTypeRejection } = await helper();
  const seen = [];
  const count = await assertJsonRpcContentTypeRejection({
    url: "http://fixture.test/rpc/example/action",
    headers: { "Antnest-Service-Authorization": "Bearer fixture-token" },
    request: async (url, input) => {
      seen.push({ url, type: input.headers.get("content-type") });
      assert.equal(
        input.headers.get("Antnest-Service-Authorization"),
        "Bearer fixture-token",
      );
      assert.equal(input.redirect, "error");
      return new Response(null, { status: 415 });
    },
  });
  assert.equal(count, seen.length);
  assert(count >= 7);
  assert(seen.some((item) => item.type === null));
  assert(seen.some((item) => item.type === "text/plain"));
  assert(
    seen.some((item) => item.type === "application/json, application/json"),
  );
});

test("accepting a browser-simple text/plain JSON POST fails the shared probe", async () => {
  const { assertJsonRpcContentTypeRejection } = await helper();
  await assert.rejects(
    assertJsonRpcContentTypeRejection({
      url: "http://fixture.test/rpc/example/action",
      request: async (_url, input) =>
        new Response(null, {
          status:
            input.headers.get("content-type") === "text/plain" ? 200 : 415,
        }),
    }),
    /text\/plain.*expected 415/u,
  );
});

test("an authentication failure cannot mask a missing media-type check", async () => {
  const { assertJsonRpcContentTypeRejection } = await helper();
  await assert.rejects(
    assertJsonRpcContentTypeRejection({
      url: "http://fixture.test/rpc/example/action",
      request: async () => new Response("private response", { status: 401 }),
    }),
    /expected 415.*got 401/u,
  );
});

test("probe failures do not print supplied secrets or response bodies", async () => {
  const { assertJsonRpcContentTypeRejection } = await helper();
  await assert.rejects(
    assertJsonRpcContentTypeRejection({
      url: "http://fixture.test/rpc/example/action",
      headers: { "Antnest-Service-Authorization": "Bearer sensitive-fixture" },
      request: async () => new Response("sensitive-response", { status: 200 }),
    }),
    (error) =>
      !error.message.includes("sensitive-fixture") &&
      !error.message.includes("sensitive-response"),
  );
});
