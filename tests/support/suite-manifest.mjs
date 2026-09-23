import assert from "node:assert/strict";
import { isAbsolute, resolve } from "node:path";
import { durablePath } from "./storage.mjs";

// References fill complete argv/environment values; they never interpolate shell text.
export function compileManifest(manifest, { output, inputs = {} }) {
  output = durablePath(output);
  assert(
    inputs && typeof inputs === "object" && !Array.isArray(inputs),
    "suite inputs must be an object",
  );
  assert(!Object.hasOwn(inputs, "output"), "output is a reserved suite input");
  for (const [key, value] of Object.entries(inputs)) {
    assert(/^[a-z][a-z0-9_]*$/.test(key), "invalid suite input name");
    assert(
      typeof value === "string" && value.length > 0,
      "suite inputs must be nonempty strings",
    );
  }
  const configured = { ...inputs, output };
  function compile(value) {
    if (Array.isArray(value)) return value.map(compile);
    if (!value || typeof value !== "object") return value;
    if (Object.hasOwn(value, "input")) {
      assert(
        Object.keys(value).every((key) => ["input", "relative"].includes(key)),
        "invalid suite input reference",
      );
      assert(
        typeof value.input === "string" &&
          Object.hasOwn(configured, value.input),
        `missing suite input: ${value.input}`,
      );
      const input = configured[value.input];
      if (!Object.hasOwn(value, "relative")) return input;
      assert(
        typeof value.relative === "string" &&
          !isAbsolute(value.relative) &&
          !value.relative.split(/[\\/]/).includes(".."),
        "invalid relative suite path",
      );
      return durablePath(resolve(input, value.relative));
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, compile(item)]),
    );
  }
  assert(
    Array.isArray(manifest) && manifest.length > 0,
    "expected a nonempty command manifest",
  );
  return compile(manifest);
}
