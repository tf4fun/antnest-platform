import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

try {
  const service = process.env.PROBE_SERVICE;
  const uid = Number(process.env.PROBE_UID),
    gid = Number(process.env.PROBE_GID);
  assert.equal(process.getuid(), uid);
  assert.equal(process.getgid(), gid);
  const outgoing = JSON.parse(process.env.PROBE_OUTGOING);
  assert.deepEqual(readdirSync("/auth/tokens").sort(), outgoing.sort());
  assert.equal(statSync("/auth/tokens").mode & 0o777, 0o700);
  for (const receiver of outgoing) {
    const path = `/auth/tokens/${receiver}`,
      raw = readFileSync(path);
    const token = raw.toString("ascii");
    assert.equal(raw.byteLength, 43);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/u);
    assert(Buffer.from(token, "base64url").toString("base64url") === token);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
  const callers = JSON.parse(readFileSync("/auth/callers.json", "utf8"));
  assert.deepEqual(
    Object.keys(callers).sort(),
    JSON.parse(process.env.PROBE_INCOMING).sort(),
  );
  assert.equal(statSync("/auth/callers.json").mode & 0o777, 0o600);
  for (const hashes of Object.values(callers)) {
    assert.equal(hashes.length, 1);
    assert.match(hashes[0], /^sha256:[0-9a-f]{64}$/u);
  }
  assert.throws(
    () => writeFileSync("/auth/callers.json", "forbidden"),
    (error) => ["EROFS", "EACCES"].includes(error.code),
  );
  assert.throws(
    () => mkdirSync("/auth/tokens/forbidden"),
    (error) => ["EROFS", "EACCES"].includes(error.code),
  );
  assert(!existsSync("/auth/manifest.json"));
  assert(!existsSync("/auth/deployment.env"));
  assert.equal(existsSync("/auth/cct.pem"), service === "identity-service");
  assert.equal(
    existsSync("/auth/master.key"),
    service === "runtime-controller",
  );
  if (service === "identity-service") {
    const issuer = createPrivateKey(readFileSync("/auth/cct.pem"));
    const jwks = JSON.parse(readFileSync("/auth/jwks.json", "utf8"));
    const message = Buffer.from("docker-bootstrap-format-check");
    assert.equal(issuer.asymmetricKeyType, "ed25519");
    assert(
      verify(
        null,
        message,
        createPublicKey({ key: jwks.keys[0], format: "jwk" }),
        sign(null, message, issuer),
      ),
    );
  }
  if (service === "runtime-controller")
    assert.equal(readFileSync("/auth/master.key").byteLength, 32);
  if (process.env.PROBE_ROTATION === "true") {
    const hash = () =>
      createHash("sha256")
        .update(readFileSync("/auth/tokens/agent-controller"))
        .digest("hex");
    assert(hash() === process.env.PROBE_CURRENT_HASH);
    console.log("ready");
    const deadline = Date.now() + 30000;
    while (hash() !== process.env.PROBE_NEXT_HASH) {
      assert(Date.now() < deadline, "rotation visibility timeout");
      await delay(25);
    }
    console.log(
      JSON.stringify({ complete: true, service, rotation_visible: true }),
    );
  } else
    console.log(
      JSON.stringify({
        complete: true,
        service,
        uid,
        gid,
        tokens: outgoing.length,
      }),
    );
} catch {
  console.error("Deployment credential mount probe failed.");
  process.exitCode = 1;
}
