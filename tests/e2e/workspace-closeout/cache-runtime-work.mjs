import assert from "node:assert/strict";

export const cacheRuntimePhase = "c4-cache-runtime-outage";
export const cacheRuntimeMarker = `${cacheRuntimePhase}: runtime output during identity outage.`;
export const cacheRuntimeFiles = Object.freeze({
  started: `/workspace/.${cacheRuntimePhase}-started`,
  effects: `/workspace/.${cacheRuntimePhase}-effects`,
  emit: `/workspace/.${cacheRuntimePhase}-emit`,
});

export function heldCacheRuntimeDecision(payload) {
  assert.equal(payload.model, "stage3-model");
  const index = payload.messages.findLastIndex((row) => row.role === "user");
  const content = payload.messages[index]?.content;
  assert.equal(
    Array.isArray(content) ? content[0]?.text : content,
    cacheRuntimePhase,
  );
  assert.equal(
    payload.messages.slice(index + 1).length,
    0,
    "held Runtime must be cancelled before any model continuation",
  );
  assert(
    payload.tools.some((tool) => tool.function.name === "bash"),
    "actual Runtime bash tool missing",
  );
  return {
    phase: cacheRuntimePhase,
    call: {
      name: "bash",
      arguments: {
        command: [
          "set -eu",
          ...Object.values(cacheRuntimeFiles).map(
            (path) => `test ! -e ${path}`,
          ),
          `printf 'started\\n' > ${cacheRuntimeFiles.effects}`,
          `printf '%s' "$$" > ${cacheRuntimeFiles.started}`,
          `while [ ! -f ${cacheRuntimeFiles.emit} ]; do sleep 0.1; done`,
          `printf 'emitted\\n' >> ${cacheRuntimeFiles.effects}`,
          `printf '${cacheRuntimeMarker}\\n'`,
          // Emitting stdout must not release the Runtime tool. Only actual
          // cancellation (or the tool's failure timeout) can end this work.
          "while :; do sleep 0.1; done",
        ].join("\n"),
        working_dir: ".",
        timeout_ms: 120000,
      },
    },
  };
}
