import { expect, it, vi } from "vitest";
import { CallerContextVerifier } from "../../src/adapters/caller-context.js";
import { signContext, testJwks } from "../support/auth-fixture.js";

it("rejects malformed context before contacting Identity and never trusts an expired cache during an outage", async () => {
  const timestamp = Date.now();
  let now = timestamp;
  const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(Response.json(testJwks())));
  const verifier = new CallerContextVerifier("http://identity.invalid/", fetcher, () => now);
  await expect(verifier.verify("bad", { requireAgent: true })).rejects.toMatchObject({
    code: "caller_context_invalid",
  });
  expect(fetcher).not.toHaveBeenCalled();
  const token = signContext({ agt: "agent-1" });
  await expect(verifier.verify(token, { requireAgent: true })).resolves.toHaveProperty(
    "agt",
    "agent-1",
  );
  expect(fetcher).toHaveBeenCalledOnce();
  await expect(verifier.verify(token, { requireAgent: true })).resolves.toHaveProperty("sub");
  expect(fetcher).toHaveBeenCalledOnce();
  now += 30001;
  fetcher.mockRejectedValue(new Error("Identity unavailable"));
  await expect(verifier.verify(token, { requireAgent: true })).rejects.toMatchObject({
    code: "identity_dependency_unavailable",
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("bounds key downloads and refuses wrong Agent scope", async () => {
  const large = vi.fn<typeof fetch>(() => Promise.resolve(new Response("x".repeat(16385))));
  const token = signContext({ agt: "agent-1" });
  await expect(
    new CallerContextVerifier("http://identity.invalid/", large).verify(token, {
      agent: "agent-1",
    }),
  ).rejects.toMatchObject({ code: "identity_dependency_unavailable" });
  const verifier = new CallerContextVerifier("http://identity.invalid/", () =>
    Promise.resolve(Response.json(testJwks())),
  );
  await expect(verifier.verify(token, { agent: "agent-2" })).rejects.toMatchObject({
    code: "caller_context_invalid",
  });
});

it("uses JSON Schema character counts for opaque signed identifiers", async () => {
  const verifier = new CallerContextVerifier("http://identity.invalid/", () =>
    Promise.resolve(Response.json(testJwks())),
  );
  const subject = "😀".repeat(200);
  await expect(
    verifier.verify(signContext({ sub: subject, agt: "agent-1" }), {
      requireAgent: true,
    }),
  ).resolves.toHaveProperty("sub", subject);
  await expect(
    verifier.verify(signContext({ sub: subject + "a", agt: "agent-1" }), {
      requireAgent: true,
    }),
  ).rejects.toMatchObject({ code: "caller_context_invalid" });
});
