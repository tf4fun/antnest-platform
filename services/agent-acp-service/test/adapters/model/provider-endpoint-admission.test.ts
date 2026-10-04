import { describe, expect, it, vi } from "vitest";
import { OpenAICompatibleModel } from "../../../src/adapters/model/openai-compatible.js";
import { snapshot } from "../../support/fixtures.js";

describe("actual model endpoint admission", () => {
  it.each([
    "http://127.0.0.1/v1",
    "http://10.0.0.1/v1",
    "http://100.100.100.200/v1",
    "http://169.254.169.254/v1",
    "http://[fd00:ec2::254]/v1",
    "http://[::ffff:127.0.0.1]/v1",
  ])("denies %s before sending the Provider credential", async (baseUrl) => {
    const source = snapshot();
    source.executionSpec.model.baseUrl = baseUrl;
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        Response.json({
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
        }),
      ),
    );
    await expect(
      new OpenAICompatibleModel({ fetchFn }).complete({
        snapshot: source,
        messages: [],
        tools: [],
        credential: "synthetic-provider-credential",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "provider_endpoint_forbidden", retryable: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
