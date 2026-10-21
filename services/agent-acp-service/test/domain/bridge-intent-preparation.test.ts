import { createHash } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
  bridgeIntentDigest,
  bridgeIntentDigestFromJson,
  canonicalPromptJson,
  promptPreparationChunk,
} from "../../src/domain/bridge-intent.js";

describe("cooperative Bridge intent preparation", () => {
  it.each([
    { name: "plain text", prompt: [{ type: "text", text: "hello" }] },
    {
      name: "escapes and Unicode",
      prompt: [{ type: "text", text: 'quotes " slash \\ control \u0000\n emoji 😀 中文 \ud800' }],
    },
    {
      name: "numeric keys and values",
      prompt: [
        {
          type: "resource",
          resource: { "10": "ten", "2": "two", z: true, a: [null, false, -0, 1e30] },
        },
      ],
    },
    {
      name: "chunk boundary",
      prompt: [{ type: "text", text: "x".repeat(65_535) + "😀" + "y".repeat(65_536) }],
    },
  ])("preserves the existing digest and JSON value for $name", async ({ prompt }) => {
    const json = canonicalPromptJson(prompt);
    expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(prompt)));
    for (const version of [0, 3, Number.MAX_SAFE_INTEGER]) {
      expect(await bridgeIntentDigestFromJson(version, json)).toBe(
        bridgeIntentDigest(version, prompt),
      );
    }
  });

  it("retains the exact historic wrapper and numeric-key enumeration", async () => {
    const json = canonicalPromptJson([{ z: 1, "10": "x", "2": "y", a: "😀" }]);
    expect(json).toBe('[{"2":"y","10":"x","a":"😀","z":1}]');
    const preimage = '{"expectedAppendVersion":3,"prompt":[{"2":"y","10":"x","a":"😀","z":1}]}';
    expect(await bridgeIntentDigestFromJson(3, json)).toBe(
      createHash("sha256").update(preimage).digest("hex"),
    );
  });

  it("does not split a supplementary character at the UTF-16 chunk boundary", async () => {
    const prefix = canonicalPromptJson([{ text: "" }]).indexOf('""') + 1;
    const prompt = [{ text: "x".repeat(promptPreparationChunk - prefix - 1) + "😀tail" }];
    const json = canonicalPromptJson(prompt);
    expect(json.charCodeAt(promptPreparationChunk - 1)).toBe(0xd83d);
    expect(json.charCodeAt(promptPreparationChunk)).toBe(0xde00);
    expect(await bridgeIntentDigestFromJson(0, json)).toBe(bridgeIntentDigest(0, prompt));
  });

  it("allows a ready control task to run before a large digest completes", async () => {
    const json = canonicalPromptJson([{ type: "image", data: "a".repeat(2 * 1024 * 1024) }]);
    const order: string[] = [];
    const ready = nextTurn().then(() => {
      order.push("control");
    });
    const digest = bridgeIntentDigestFromJson(0, json).then((value) => {
      order.push("digest");
      return value;
    });
    await Promise.all([ready, digest]);
    expect(order).toEqual(["control", "digest"]);
  });

  it("continues admitting control tasks after hashing has started", async () => {
    const json = canonicalPromptJson([{ type: "image", data: "a".repeat(2 * 1024 * 1024) }]);
    const order: string[] = [];
    const digest = bridgeIntentDigestFromJson(0, json).then(() => {
      order.push("digest");
    });
    const control = (async () => {
      await nextTurn();
      await nextTurn();
      order.push("control");
    })();
    await Promise.all([digest, control]);
    expect(order).toEqual(["control", "digest"]);
  });
});
