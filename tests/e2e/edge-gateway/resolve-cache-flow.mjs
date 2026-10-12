import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import { member } from "../workspace-closeout/c4-setup.mjs";
import { connectOwner } from "../lifecycle-closeout/acp.mjs";
import { writeEvidenceFile } from "../../support/storage.mjs";
import { inspectLoadWire } from "./resolve-cache-load.mjs";
import { collectResolveLoad } from "./resolve-cache-collect.mjs";

export async function verifyResolveLoad({
  config,
  fixture,
  settings,
  signal,
  output,
}) {
  const client = new GatewayClient(config.gateway);
  await client.request("/api/session/login", { body: member });
  const secrets = [member.password, client.cookie, ...client.cookies.values()];
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
  // No same-token ACP prewarm: the timed interval starts inside connectOwner
  // before dialing. No browser, activity reporter or other stream uses it.
  const connection = connectOwner(
    config.gateway,
    fixture.agentID,
    client.cookie,
    deadline,
    { captureWire: true, injectTraceParent: false },
  );
  const wire = connection.wire;
  try {
    await connection.initialize();
    for (let index = 0; index < 100; index++) {
      if (index === 50) {
        // Keep the whole test below eight seconds while deliberately crossing
        // half TTL, so the independent counter must also witness refresh.
        await delay(
          Math.max(0, wire.upgrade.at + 5500 - performance.now()),
          undefined,
          { signal: deadline },
        );
      }
      await connection.request(
        "list",
        {},
        Math.max(1, Math.floor(8000 - (performance.now() - wire.started_at))),
      );
    }
    wire.completed_at = performance.now();
    inspectLoadWire(wire);
  } finally {
    try {
      await connection.closeAndWait();
    } finally {
      assertSecretFree(JSON.stringify(wire), secrets);
      writeEvidenceFile(
        output,
        "load-wire.private.json",
        JSON.stringify(wire, null, 2),
      );
    }
  }
  const result = await collectResolveLoad(
    config.jaeger,
    wire,
    fixture.agentID,
    settings,
    secrets,
    {
      signal,
      directory: join(output, "load"),
    },
  );
  assert(
    result.background_refreshes >= 1,
    "half-TTL load did not witness actual refresh",
  );
  return result;
}
