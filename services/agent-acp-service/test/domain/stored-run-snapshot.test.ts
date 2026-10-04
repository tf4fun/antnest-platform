import { describe, expect, it } from "vitest";
import { parseStoredRunSnapshot } from "../../src/domain/stored-run-snapshot.js";
import { snapshot } from "../support/fixtures.js";

describe("stored Runtime reference", () => {
  function record() {
    const value = JSON.parse(JSON.stringify(snapshot())) as Record<string, unknown>;
    value.runtime = {
      ...(value.runtime as Record<string, unknown>),
      connectionId: "rci_11111111111111111111111111111111",
    };
    return value;
  }

  it("preserves the public instance identity through Run storage", () => {
    expect(parseStoredRunSnapshot(record()).runtime).toHaveProperty(
      "connectionId",
      "rci_11111111111111111111111111111111",
    );
  });

  it("rejects a stored Runtime credential instead of forwarding it", () => {
    const value = record();
    (value.runtime as Record<string, unknown>).credential = {
      caller: "agent-acp-service",
      token: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
    };
    expect(() => parseStoredRunSnapshot(value)).toThrow();
  });
});
