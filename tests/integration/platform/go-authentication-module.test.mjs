import assert from "node:assert/strict";
import { test } from "node:test";
import { checkGoAuthenticationModule } from "../../support/check-go-authentication-module.mjs";

const module =
  "github.com/tf4fun/antnest-platform/modules/service-authentication";

test("all Go authentication consumers use the shared module and standalone builds", () => {
  assert.deepEqual(checkGoAuthenticationModule(), []);
});

for (const [name, path, source, expected] of [
  [
    "private serviceauth package",
    "services/edge-gateway/internal/restored/config.go",
    "package serviceauth\n",
    /private serviceauth/u,
  ],
  [
    "private CCT package",
    "services/admin-console/internal/restored/verify.go",
    "package callercontext\n",
    /private callercontext/u,
  ],
  [
    "renamed Identity verifier copy",
    "services/identity-service/internal/callercontext/restored.go",
    "package callercontext\nfunc Verify() {}\n",
    /copied CCT verifier/u,
  ],
  [
    "library importing a service implementation",
    "modules/service-authentication/callercontext/restored.go",
    'package callercontext\nimport "github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"\n',
    /imports a service implementation/u,
  ],
]) {
  test(`rejects ${name}`, () => {
    assert(
      checkGoAuthenticationModule({
        additionalSources: { [path]: source },
      }).some((error) => expected.test(error)),
    );
  });
}

for (const [name, path, mutate, expected] of [
  [
    "missing direct dependency",
    "services/admin-console/go.mod",
    (source) =>
      source.replace(`${module} v0.0.0`, "example.org/unrelated v0.0.0"),
    /direct shared module dependency/u,
  ],
  [
    "missing standalone replace",
    "services/runtime-controller/go.mod",
    (source) =>
      source.replace(
        `replace ${module} => ../../modules/service-authentication`,
        "",
      ),
    /standalone shared module replace/u,
  ],
  [
    "missing Docker library input",
    "services/skill-registry/Dockerfile",
    (source) =>
      source.replace(/^COPY modules\/service-authentication .*\n/gmu, ""),
    /Docker shared module input/u,
  ],
  [
    "flattened Docker layout",
    "services/edge-gateway/Dockerfile",
    (source) =>
      source.replace("WORKDIR /src/services/edge-gateway", "WORKDIR /src"),
    /Docker repository layout/u,
  ],
  [
    "missing consumer CI coverage",
    ".github/workflows/agent-controller.yml",
    (source) =>
      source.replace(/^\s*- modules\/service-authentication\/\*\*\n/gmu, ""),
    /consumer CI coverage/u,
  ],
  [
    "missing shared CI",
    ".github/workflows/shared-go-authentication.yml",
    () => "",
    /shared module CI/u,
  ],
  [
    "missing workspace member",
    "go.work",
    (source) =>
      source.replace("./modules/service-authentication", "./modules/unrelated"),
    /workspace member/u,
  ],
  [
    "wrong Registry forwarding policy",
    "services/skill-registry/cmd/skill-registry/main.go",
    (source) =>
      source.replaceAll(
        "serviceauth.WorkloadOnlyHeaders",
        "serviceauth.CallerContextHeaders",
      ),
    /outbound authority policy/u,
  ],
]) {
  test(`rejects ${name}`, () => {
    const errors = checkGoAuthenticationModule({
      transform: (file, source) => (file === path ? mutate(source) : source),
    });
    assert(errors.some((error) => expected.test(error)));
  });
}
