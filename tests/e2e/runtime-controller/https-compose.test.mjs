import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { composeConfig } from "../../support/compose-config.mjs";
import { guardRules } from "./https-probe.mjs";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const source = require("yaml").parse(
  readFileSync(new URL("./https.compose.yaml", import.meta.url), "utf8"),
);

test("HTTPS fixture reuses the candidate Runtime image on only the Egress network", () => {
  const image = "antnest/antnest-runtime:https-probe-candidate";
  const config = composeConfig(
    ["compose.yaml", "tests/e2e/runtime-controller/https.compose.yaml"],
    {
      ANTNEST_E2E_RUNTIME_IMAGE: image,
      ANTNEST_EGRESS_FIXTURE_TLS_DIRECTORY: "/never-mounted-disposable-tls",
      ANTNEST_EGRESS_FIXTURE_NONCE: "a".repeat(32),
    },
  );
  const target = config.services["egress-https-target"];
  assert.equal(target.image, image);
  assert.equal(target.build, undefined);
  assert.equal(target.ports, undefined);
  assert.deepEqual(Object.keys(target.networks), ["egress"]);
  assert.deepEqual(target.cap_add, ["NET_ADMIN"]);
  assert.deepEqual(target.cap_drop, ["ALL"]);
  assert.equal(target.read_only, true);
  assert(target.volumes.every((volume) => volume.read_only));
  assert.deepEqual(target.volumes.map((volume) => volume.target).sort(), [
    "/fixtures",
    "/tls/cert.pem",
    "/tls/key.pem",
  ]);
  for (const volume of target.volumes.filter((volume) =>
    volume.target.startsWith("/tls/"),
  )) {
    // Older Compose omits false booleans from JSON; require the explicit
    // source boundary as well and still reject a rendered true.
    assert.equal(
      source.services["egress-https-target"].volumes.find(
        (entry) => entry.target === volume.target,
      ).bind.create_host_path,
      false,
    );
    assert.equal(volume.bind?.create_host_path ?? false, false);
    assert.equal(
      volume.source,
      `/never-mounted-disposable-tls/${volume.target.split("/").at(-1)}`,
    );
  }
  assert.equal(
    config.services["runtime-egress"].environment.ANTNEST_EGRESS_DNS_UPSTREAM,
    "1.1.1.1:15353",
  );
  const rules = guardRules();
  assert(
    rules.includes(
      'iifname "antnest-egress0" ip saddr 100.64.0.0/10 ip daddr != 1.1.1.1 drop',
    ),
  );
  assert(rules.includes("tcp dport != 8443 drop"));
  assert(rules.includes("meta l4proto != tcp drop"));
  assert(!rules.includes("dnat") && !rules.includes("flush ruleset"));
});
