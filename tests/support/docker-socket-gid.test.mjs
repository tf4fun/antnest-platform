import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveDockerSocketGid,
  validateDockerSocketGid,
} from "../../scripts/docker-socket-gid.mjs";

test("socket GID detection uses Docker's view on Linux and Docker Desktop", async () => {
  for (const gid of ["0", "998", "1001"]) {
    const calls = [];
    const result = await resolveDockerSocketGid(async (args) => {
      calls.push(args);
      return gid + "\n";
    }, "");
    assert.equal(result, gid);
    assert.equal(calls.length, 1);
    const [args] = calls;
    assert.equal(args[0], "run");
    for (const argument of [
      "--rm",
      "--pull=never",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--network",
      "none",
      "--user",
      "65532:65532",
      "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock,readonly",
    ])
      assert(args.includes(argument), argument);
    assert(args.at(-1).includes("isSocket()"));
    assert(args.at(-1).includes("socket.gid"));
  }
});

test("an explicit numeric socket GID bypasses Docker and accepts group zero", async () => {
  for (const gid of ["0", "998"]) {
    assert.equal(
      await resolveDockerSocketGid(() => {
        throw new Error("override must not invoke Docker");
      }, gid),
      gid,
    );
  }
});

test("missing or malformed socket GIDs fail with an actionable error", async () => {
  for (const value of [
    undefined,
    "",
    "-1",
    "01",
    " 1",
    "1\n",
    "x",
    "4294967295",
  ]) {
    assert.throws(
      () => validateDockerSocketGid(value),
      /ANTNEST_DOCKER_SOCKET_GID/u,
    );
  }
  for (const result of ["", "unknown", "0\n1", "4294967295"]) {
    await assert.rejects(
      resolveDockerSocketGid(async () => result, ""),
      /ANTNEST_DOCKER_SOCKET_GID/u,
    );
  }
  await assert.rejects(
    resolveDockerSocketGid(async () => {
      throw new Error("daemon unavailable");
    }, ""),
    /ANTNEST_DOCKER_SOCKET_GID/u,
  );
});
