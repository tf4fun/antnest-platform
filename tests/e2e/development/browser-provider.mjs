import assert from "node:assert/strict";

export function developmentBrowserProvider(options) {
  const scope = options["provider-scope"] ?? "external";
  assert(
    ["external", "controlled"].includes(scope),
    "invalid Development provider scope",
  );
  const runtimeImage =
    options["runtime-image"] ?? "antnest/antnest-runtime:local";
  assert(
    typeof runtimeImage === "string" &&
      runtimeImage.length > 0 &&
      !/\s/u.test(runtimeImage),
    "invalid Development Runtime image",
  );
  if (scope === "external") {
    assert(
      options["provider-endpoint"] === undefined,
      "an overridden provider requires controlled scope",
    );
    return { scope, runtimeImage, greetingCheck: "real_deepseek_greeting" };
  }
  assert(
    options.agent === undefined,
    "controlled Development requires Console creation in a blank instance",
  );
  assert.equal(
    options["provider-endpoint"],
    "http://stage3-model:8080/v1",
    "controlled Development provider endpoint required",
  );
  assert.match(
    runtimeImage,
    /^antnest\/antnest-runtime:shell-[a-f0-9]{8}$/u,
    "controlled Development requires the fresh Runtime candidate",
  );
  return {
    scope,
    endpoint: options["provider-endpoint"],
    runtimeImage,
    greetingCheck: "controlled_provider_greeting",
  };
}
