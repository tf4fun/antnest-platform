import assert from "node:assert/strict";
import { networkInterfaces } from "node:os";
import { member } from "../workspace-closeout/c4-setup.mjs";

const statuses = [];
const sourceLimit = Number(process.env.TLS_TEST_SOURCE_LIMIT);
const victim = process.env.TLS_TEST_CLIENT === "victim";
for (let index = 0; index <= sourceLimit; index++) {
  const response = await fetch("https://tls-proxy:8443/api/session/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: process.env.TEST_GATEWAY_PUBLIC_URL,
      // Caddy must replace this forged prefix with the actual container peer.
      "X-Forwarded-For": `198.51.100.${index + 1}`,
      "X-Forwarded-Proto": "http",
      "X-Forwarded-Host": "forged.example",
      Forwarded: "for=198.51.100.99;proto=http",
      "X-Real-IP": "198.51.100.99",
    },
    body: JSON.stringify(
      victim && index === 0
        ? member
        : {
            ...member,
            email: `${victim ? "victim" : "attacker"}-${index}@example.test`,
            password: "deliberately-invalid",
          },
    ),
    signal: AbortSignal.timeout(15000),
  });
  await response.arrayBuffer();
  statuses.push(response.status);
  const expected =
    index === sourceLimit ? 429 : victim && index === 0 ? 200 : 401;
  if (response.status !== expected)
    throw new Error(
      `${victim ? "victim" : "attacker"} login ${index + 1}: expected ${expected}, statuses ${statuses.join(",")}`,
    );
  assert.equal(
    response.headers.get("strict-transport-security"),
    "max-age=31536000",
  );
}
const address = Object.values(networkInterfaces())
  .flat()
  .find((item) => item.family === "IPv4" && !item.internal)?.address;
assert(address);
console.log(JSON.stringify({ address, statuses }));
