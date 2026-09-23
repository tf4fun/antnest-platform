import assert from "node:assert/strict";
import test from "node:test";
import { dockerTestEnvironment } from "./docker-test-images.mjs";

test("Docker image contracts require the current Unix endpoint and distinct installed images", async () => {
  const calls = [];
  const docker = async (argv) => {
    calls.push(argv);
    if (argv[0] === "context") return "unix:///tmp/antnest-probe.sock";
    return JSON.stringify([{ Id: "sha256:first" }, { Id: "sha256:second" }]);
  };
  const env = await dockerTestEnvironment({
    image: "fixture:first",
    movedImage: "fixture:second",
    env: { TEST_POSTGRES_URL: "disposable" },
    docker,
  });
  assert.equal(env.TEST_POSTGRES_URL, "disposable");
  assert.equal(
    env.ANTNEST_RUNTIME_CONTROLLER_TEST_DOCKER_SOCKET,
    "/tmp/antnest-probe.sock",
  );
  assert.equal(env.ANTNEST_RUNTIME_CONTROLLER_TEST_IMAGE_TAG, "fixture:first");
  assert.equal(
    env.ANTNEST_RUNTIME_CONTROLLER_TEST_MOVED_IMAGE_TAG,
    "fixture:second",
  );
  assert.deepEqual(calls[1], [
    "image",
    "inspect",
    "fixture:first",
    "fixture:second",
  ]);
});

test("remote Docker endpoints and same-ID image aliases cannot silently skip real image tests", async () => {
  await assert.rejects(
    dockerTestEnvironment({
      image: "first",
      movedImage: "second",
      env: { DOCKER_HOST: "tcp://remote:2376" },
      docker: () => {
        throw new Error("must not inspect");
      },
    }),
    /Unix/,
  );
  await assert.rejects(
    dockerTestEnvironment({
      image: "first",
      movedImage: "second",
      env: { DOCKER_HOST: "unix:///tmp/probe.sock" },
      docker: async () => JSON.stringify([{ Id: "same" }, { Id: "same" }]),
    }),
    /different/,
  );
  await assert.rejects(
    dockerTestEnvironment({
      image: "first",
      movedImage: "second",
      env: {},
      docker: async (argv) =>
        argv[0] === "context" ? "unix:///tmp/probe.sock" : "[]",
    }),
    /installed/,
  );
});

test("explicit image and output inputs reject before Docker access", async () => {
  let calls = 0;
  const docker = async () => {
    calls++;
    return "";
  };
  await assert.rejects(
    dockerTestEnvironment({ image: "", movedImage: "second", env: {}, docker }),
    /reference/,
  );
  await assert.rejects(
    dockerTestEnvironment({
      image: "-bad",
      movedImage: "second",
      env: {},
      docker,
    }),
    /reference/,
  );
  assert.equal(calls, 0);
});
