import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function assertContainerPrivileges(service, container, socketGid) {
  assert(["runtime-egress", "runtime-controller"].includes(service));
  const profile = container.HostConfig;
  assert(
    profile.CapDrop?.includes("ALL"),
    `${service}: CapDrop must contain ALL`,
  );
  assert(
    profile.SecurityOpt?.some((value) =>
      /^no-new-privileges(?::true|=true)?$/u.test(value),
    ),
    `${service}: no-new-privileges is required`,
  );
  assert.equal(
    profile.ReadonlyRootfs,
    true,
    `${service}: rootfs must be read-only`,
  );
  const capabilities = (profile.CapAdd ?? [])
    .map((value) => value.replace(/^CAP_/u, ""))
    .sort();
  if (service === "runtime-egress") {
    assert.equal(container.Config.User, "0:0");
    assert.deepEqual(capabilities, ["NET_ADMIN"]);
  } else {
    assert.match(
      container.Config.User,
      /^[1-9][0-9]*(?::[0-9]+)?$/u,
      "Runtime Controller must use a non-zero numeric UID",
    );
    assert.deepEqual(capabilities, []);
    assert(
      profile.GroupAdd?.includes(socketGid),
      "Runtime Controller needs the detected socket group",
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [container] = JSON.parse(readFileSync(0, "utf8"));
  const service = process.argv[2];
  assertContainerPrivileges(
    service,
    container,
    process.env.ANTNEST_DOCKER_SOCKET_GID,
  );
  console.log(JSON.stringify({ service, hardened: true }));
}
