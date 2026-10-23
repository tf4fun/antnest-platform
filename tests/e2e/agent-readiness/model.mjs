import assert from "node:assert/strict";
import { createLifecycleModel } from "../lifecycle-closeout/model.mjs";

createLifecycleModel((payload) => {
  assert.equal(payload.model, "stage3-model");
  const phase = payload.messages.findLast(
    (message) => message.role === "user",
  )?.content;
  assert.match(phase, /^readiness-[1-9][0-9]{0,2}$/);
  assert(Number(phase.slice("readiness-".length)) <= 100);
  assert(!payload.messages.some((message) => message.role === "tool"));
  return { phase, text: `${phase} completed` };
}).listen(8080, "0.0.0.0");
