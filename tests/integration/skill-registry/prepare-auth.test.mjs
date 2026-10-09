import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  verify,
} from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { callerContext } from "../../e2e/service-authentication/registry/auth-fixture.mjs";
import { prepareAuthentication } from "./prepare-auth.mjs";

const hash = (token) =>
  "sha256:" + createHash("sha256").update(token, "ascii").digest("hex");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const mode = (path) => statSync(path).mode & 0o777;

test("registry and controller receive disjoint, matching credentials", (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), "antnest-prepare-auth-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { registry, controller, credentials } =
    prepareAuthentication(directory);
  const secrets = json(credentials);
  const registryCallers = json(resolve(registry, "callers.json"));
  const controllerCallers = json(resolve(controller, "callers.json"));

  assert.deepEqual(Object.keys(controllerCallers), ["agent-controller"]);
  assert.deepEqual(controllerCallers["agent-controller"], [
    hash(secrets.agent_controller),
  ]);
  assert.deepEqual(registryCallers["admin-console"], [
    hash(secrets.admin_console),
  ]);
  const outgoing = readFileSync(
    resolve(controller, "outgoing", "skill-registry"),
    "ascii",
  );
  assert.match(outgoing, /^[A-Za-z0-9_-]{43,86}$/u);
  assert.deepEqual(registryCallers["runtime-controller"], [hash(outgoing)]);
  assert.equal(registryCallers["skill-registry"], undefined);
  assert.notEqual(secrets.agent_controller, secrets.admin_console);

  const key = readFileSync(resolve(controller, "instance-master"));
  assert.equal(key.length, 32);
  for (const path of [
    credentials,
    resolve(controller, "callers.json"),
    resolve(controller, "outgoing", "skill-registry"),
    resolve(controller, "instance-master"),
  ])
    assert.equal(mode(path), 0o600, path);
  assert.equal(mode(resolve(controller, "outgoing")), 0o700);

  const peers = json(resolve(registry, "peers.json"));
  const context = callerContext({
    privateKey: createPrivateKey(secrets.caller_context_key),
  });
  const [header, body, signature] = context.split(".");
  const { kid, use, alg, ...jwk } = peers.jwks.keys[0];
  assert.deepEqual([kid, use, alg], ["registry-fixture", "sig", "EdDSA"]);
  assert(
    verify(
      null,
      Buffer.from(`${header}.${body}`),
      createPublicKey({ key: jwk, format: "jwk" }),
      Buffer.from(signature, "base64url"),
    ),
  );
});
