import assert from "node:assert/strict";
import { request } from "node:http";

const plan = JSON.parse(process.argv[2]);
let checks = 0;
let currentProbe;
async function closed(probe) {
  await new Promise((done, reject) => {
    let settled = false;
    let deadline;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error);
      else done();
    };
    // Docker Desktop can accept a TCP handshake without forwarding HTTP into
    // an isolated bridge. Any HTTP response, including 401/404, proves access.
    const outgoing = request(
      {
        host: probe.address,
        port: probe.port,
        method: "GET",
        path: "/",
        agent: false,
      },
      (incoming) => {
        incoming.destroy();
        outgoing.destroy();
        finish(
          new Error(
            `${probe.service}: forbidden interface returned HTTP ${incoming.statusCode}`,
          ),
        );
      },
    );
    outgoing.once("error", (error) =>
      finish(error.code?.startsWith("HPE_") ? error : undefined),
    );
    outgoing.once("upgrade", (_response, socket) => {
      socket.destroy();
      outgoing.destroy();
      finish(new Error(`${probe.service}: forbidden interface upgraded HTTP`));
    });
    deadline = setTimeout(() => {
      outgoing.destroy();
      finish();
    }, 1500);
    outgoing.end();
  });
  checks++;
}
async function denied(probe, forged) {
  const payload = probe.body
    ? JSON.stringify({
        organization_id: `org_${"f".repeat(32)}`,
        actor_user_id: `user_${"f".repeat(32)}`,
        actor_id: `user_${"f".repeat(32)}`,
      })
    : undefined;
  const response = await new Promise((done, reject) => {
    const outgoing = request(
      {
        host: probe.address,
        port: probe.port,
        method: probe.method,
        path: probe.path,
        headers: {
          ...(probe.upgrade
            ? {
                Connection: "Upgrade",
                Upgrade: "websocket",
                "Sec-WebSocket-Version": "13",
                "Sec-WebSocket-Key": "MDEyMzQ1Njc4OWFiY2RlZg==",
              }
            : {}),
          ...(payload === undefined
            ? {}
            : {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }),
          ...(forged
            ? {
                Authorization: "Bearer forged-session",
                "X-Antnest-Service": "agent-controller",
                "X-Antnest-Organization-ID": `org_${"f".repeat(32)}`,
                "X-Antnest-User-ID": `user_${"f".repeat(32)}`,
                "X-Antnest-Role": "admin",
                "Antnest-Caller-Context": "forged.context.signature",
              }
            : {}),
        },
      },
      (incoming) => {
        let body = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk) => {
          body += chunk;
          if (body.length > 16384)
            incoming.destroy(new Error("probe response exceeds limit"));
        });
        incoming.once("error", reject);
        incoming.once("end", () =>
          done({
            status: incoming.statusCode,
            body,
            headers: incoming.headers,
          }),
        );
      },
    );
    outgoing.setTimeout(5000, () =>
      outgoing.destroy(new Error("probe request timed out")),
    );
    outgoing.once("error", reject);
    outgoing.once("upgrade", (_response, socket) => {
      socket.destroy();
      reject(new Error("unauthenticated WebSocket upgrade accepted"));
    });
    outgoing.end(payload);
  });
  assert.equal(
    response.status,
    probe.status,
    `${plan.key}/${probe.service} ${probe.method} ${probe.path}`,
  );
  if (probe.status === 401) {
    if (probe.method !== "HEAD") {
      const document = JSON.parse(response.body);
      assert.equal(
        document.code ?? document.error?.code,
        "service_unauthenticated",
      );
    }
    assert.equal(
      response.headers["www-authenticate"],
      'Bearer realm="antnest-service"',
    );
  }
  assert(!response.body.includes("forged.context.signature"));
  checks++;
}
try {
  for (const probe of plan.probes) {
    currentProbe = probe;
    if (probe.closed) await closed(probe);
    else {
      await denied(probe, false);
      await denied(probe, true);
    }
  }
  console.log(
    JSON.stringify({
      network: plan.key,
      internal: plan.internal,
      checks,
      status: "passed",
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      network: plan.key,
      checks,
      status: "failed",
      probe: currentProbe,
      error: { name: error.name, message: error.message.slice(0, 1024) },
    }),
  );
  throw error;
}
