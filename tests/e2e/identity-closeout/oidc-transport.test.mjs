import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { inspect } from "node:util";
import test from "node:test";
import { createFixtureClient, parseFixtureJSON } from "./oidc-transport.mjs";

test("fixture transport preserves TLS identity and redirects without following", async () => {
  const ca = Buffer.from("fixture-ca");
  const idp = createFixtureClient({
    issuer: "https://oidc-fixture:8443",
    port: 12345,
    ca,
    request(target, options, callback) {
      assert.equal(target.pathname, "/profile/authorize");
      assert.equal(options.hostname, "127.0.0.1");
      assert.equal(options.servername, "oidc-fixture");
      assert.equal(options.ca, ca);
      assert.equal(options.port, 12345);
      assert.equal(options.headers.Cookie, "oidc_fixture_account=profile");
      const response = new PassThrough();
      response.statusCode = 302;
      response.headers = { location: "http://gateway/callback?code=secret" };
      const outgoing = new EventEmitter();
      outgoing.end = () => {
        callback(response);
        response.end("redirect");
      };
      return outgoing;
    },
  });
  assert.deepEqual(await idp("/profile/authorize", { account: "profile" }), {
    status: 302,
    headers: { location: "http://gateway/callback?code=secret" },
    text: "redirect",
  });
  await assert.rejects(
    idp("https://foreign.test"),
    /unexpected fixture issuer/,
  );
});

for (const phase of ["creation", "request", "response"])
  test(`fixture ${phase} failure cannot expose the original error`, async () => {
    const failure = new Error("private-fixture-credential", {
      cause: new Error("private-nested-credential"),
    });
    const idp = createFixtureClient({
      issuer: "https://oidc-fixture:8443",
      port: 12345,
      ca: Buffer.from("fixture-ca"),
      request(_target, _options, callback) {
        if (phase === "creation") throw failure;
        const outgoing = new EventEmitter();
        outgoing.end = () => {
          if (phase === "request") outgoing.emit("error", failure);
          else {
            const response = new PassThrough();
            callback(response);
            response.destroy(failure);
          }
        };
        return outgoing;
      },
    });
    await assert.rejects(idp("/fixture/canaries"), (error) => {
      assert.equal(error.message, "HTTPS IdP fixture request failed");
      assert(!inspect(error).includes("private-"));
      assert.equal(error.cause, undefined);
      return true;
    });
  });

test("fixture JSON parser never prints malformed canary responses", () => {
  assert.deepEqual(parseFixtureJSON('["canary"]'), ["canary"]);
  assert.throws(
    () => parseFixtureJSON('["private-canary-credential"'),
    (error) => {
      assert.equal(error.message, "HTTPS IdP fixture returned invalid JSON");
      assert(!inspect(error).includes("private-canary-credential"));
      return true;
    },
  );
});
