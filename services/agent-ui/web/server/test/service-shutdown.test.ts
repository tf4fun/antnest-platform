import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as immediate } from "node:timers/promises";

const url = new URL("../src/service-shutdown.ts", import.meta.url);
const implementation = await import(url.href).catch((error: unknown) => {
  const missing = error as { code?: string; url?: string };
  if (missing.code === "ERR_MODULE_NOT_FOUND" && missing.url === url.href)
    return {};
  throw error;
});

type Options = {
  service: { close(): Promise<void> };
  telemetry: { shutdown(): Promise<void> };
  authentication: { close(): Promise<void> };
  reportError(message: string, error?: unknown): void;
  reportWarning(message: string, error: unknown): void;
};

function shutdown(options: Options): Promise<0 | 1> {
  assert.equal(typeof implementation.shutdownWorkspaceService, "function");
  return implementation.shutdownWorkspaceService(options);
}

for (let failures = 0; failures < 8; failures++) {
  test(`service shutdown joins every resource with failure mask ${failures}`, async () => {
    const calls: string[] = [];
    const errors: unknown[][] = [],
      warnings: unknown[][] = [];
    const causes = [
      new Error("service"),
      new Error("telemetry"),
      new Error("authentication"),
    ];
    const close = async (index: number, name: string) => {
      calls.push(name);
      if (failures & (1 << index)) throw causes[index];
    };
    const result = await shutdown({
      service: { close: () => close(0, "service") },
      telemetry: { shutdown: () => close(1, "telemetry") },
      authentication: { close: () => close(2, "authentication") },
      reportError: (...values) => {
        errors.push(values);
      },
      reportWarning: (...values) => {
        warnings.push(values);
      },
    });
    assert.deepEqual(calls, ["service", "telemetry", "authentication"]);
    assert.equal(result, failures & 5 ? 1 : 0);
    assert.deepEqual(errors, [
      ...(failures & 1 ? [["Bridge shutdown failed", causes[0]]] : []),
      ...(failures & 4
        ? [["Bridge authentication client shutdown failed"]]
        : []),
    ]);
    assert.deepEqual(
      warnings,
      failures & 2 ? [["Bridge telemetry shutdown warning", causes[1]]] : [],
    );
  });
}

for (const held of ["service", "telemetry", "authentication"] as const) {
  test(
    `shutdown waits for actual ${held} completion`,
    { timeout: 2000 },
    async () => {
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const calls: string[] = [];
      let settled = false;
      const close = async (name: string) => {
        calls.push(`${name}:start`);
        if (name === held) {
          entered.resolve();
          await release.promise;
        }
        calls.push(`${name}:end`);
      };
      const pending = shutdown({
        service: { close: () => close("service") },
        telemetry: { shutdown: () => close("telemetry") },
        authentication: { close: () => close("authentication") },
        reportError: () => assert.fail("unexpected business close failure"),
        reportWarning: () => assert.fail("unexpected telemetry warning"),
      }).finally(() => {
        settled = true;
      });
      try {
        await entered.promise;
        await immediate();
        assert.equal(settled, false);
        assert.equal(calls.includes(`${held}:end`), false);
        release.resolve();
        assert.equal(await pending, 0);
        assert.deepEqual(calls, [
          "service:start",
          "service:end",
          "telemetry:start",
          "telemetry:end",
          "authentication:start",
          "authentication:end",
        ]);
      } finally {
        release.resolve();
        await pending;
      }
    },
  );
}
