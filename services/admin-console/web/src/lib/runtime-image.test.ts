import assert from "node:assert/strict";
import test from "node:test";
import { runtimeImageLabel } from "./runtime-image.ts";

test("resolved images display their server-derived source without exposing the pin", () => {
  assert.equal(runtimeImageLabel(`sha256:${"a".repeat(64)}`, "registry.example/runtime:v1"), "registry.example/runtime:v1");
});

for (const [reference, label] of [
  [`registry.example.com:5000/antnest/runtime:v1@sha256:${"a".repeat(64)}`, "registry.example.com:5000/antnest/runtime:v1"],
  [`antnest/runtime@sha256:${"a".repeat(64)}`, "antnest/runtime"],
  [`sha256:${"a".repeat(64)}`, "Platform runtime"],
  ["", "Platform runtime"],
  ["  antnest/runtime:local  ", "antnest/runtime:local"],
]) {
  test(`runtime presentation renders ${label} without a digest`, () => {
    assert.equal(runtimeImageLabel(reference), label);
    assert.equal(runtimeImageLabel(reference).includes("sha256:"), false);
  });
}
