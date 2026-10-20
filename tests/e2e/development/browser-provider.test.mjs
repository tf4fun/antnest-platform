import assert from "node:assert/strict";
import test from "node:test";

test("Development preserves external-provider defaults and labels controlled acceptance explicitly", async () => {
  const { developmentBrowserProvider } = await import("./browser-provider.mjs");
  assert.deepEqual(developmentBrowserProvider({}), {
    scope: "external",
    runtimeImage: "antnest/antnest-runtime:local",
    greetingCheck: "real_deepseek_greeting",
  });
  assert.deepEqual(
    developmentBrowserProvider({
      "provider-scope": "controlled",
      "provider-endpoint": "http://stage3-model:8080/v1",
      "runtime-image": "antnest/antnest-runtime:shell-1234abcd",
    }),
    {
      scope: "controlled",
      endpoint: "http://stage3-model:8080/v1",
      runtimeImage: "antnest/antnest-runtime:shell-1234abcd",
      greetingCheck: "controlled_provider_greeting",
    },
  );
});
for (const options of [
  { "provider-scope": "pretend" },
  { "provider-endpoint": "http://stage3-model:8080/v1" },
  { "provider-scope": "controlled" },
  {
    "provider-scope": "controlled",
    "provider-endpoint": "http://stage3-model:8080/v1",
    "runtime-image": "antnest/antnest-runtime:shell-1234abcd",
    agent: "agent_existing",
  },
  {
    "provider-scope": "controlled",
    "provider-endpoint": "https://api.deepseek.com/v1",
    "runtime-image": "antnest/antnest-runtime:shell-1234abcd",
  },
  {
    "provider-scope": "controlled",
    "provider-endpoint": "http://stage3-model:8080/v1",
    "runtime-image": "antnest/antnest-runtime:local",
  },
])
  test(`Development refuses inconsistent provider scope ${JSON.stringify(options)}`, async () => {
    const { developmentBrowserProvider } =
      await import("./browser-provider.mjs");
    assert.throws(() => developmentBrowserProvider(options));
  });
