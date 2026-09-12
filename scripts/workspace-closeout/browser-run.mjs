import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  configuration,
  dockerClient,
  composeArgs,
  cleanup,
} from "../lifecycle-closeout/docker.mjs";
import { runFlow } from "../lifecycle-closeout/flow.mjs";
import { note, imageData } from "./browser-model.mjs";
import { waitForFinish, assertWorkspaceBytes } from "./browser-control.mjs";

process.chdir(fileURLToPath(new URL("../../", import.meta.url)));
const abort = new AbortController();
const interrupt = () =>
  abort.abort(new Error("Browser acceptance interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const timer = setTimeout(interrupt, 1800000);
const input = createInterface({ input: process.stdin });
const finished = waitForFinish(input, abort).then(
  () => true,
  () => false,
);
abort.signal.addEventListener("abort", () => input.close(), { once: true });
let config, directory, result;
try {
  directory = await mkdtemp(join(tmpdir(), "antnest-browser-"));
  await writeFile(join(directory, "workspace-notes.md"), note);
  await writeFile(
    join(directory, "sample.png"),
    Buffer.from(imageData, "base64"),
  );
  await writeFile(join(directory, "unsupported.bin"), Buffer.from([0, 255]));
  config = await configuration(abort.signal);
  console.error(`Disposable browser project: ${config.project}`);
  const docker = dockerClient(config.env, abort.signal, 1800000);
  await docker(
    composeArgs(config.project, [
      "-f",
      "scripts/workspace-closeout/browser.compose.yaml",
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "180",
      "--no-build",
    ]),
    true,
  );
  result = await runFlow(
    config,
    docker,
    abort.signal,
    async ({ json, agentBody, command, ready }) => {
      const model = await json("/api/admin/model-profiles", {
        status: 201,
        body: {
          display_name: "Browser native fixture",
          api_key: "stage3-model-secret",
          model: {
            base_url: "http://stage3-model:8080/v1",
            model: "stage3-model",
            context_window: 8192,
            max_output_tokens: 1024,
            supports_images: true,
            supports_audio: true,
            supports_pdf: true,
          },
        },
      });
      const template = await json("/api/admin/templates", {
        status: 201,
        body: {
          name: "Browser fixture",
          model_profile_revision_id: model.revision_id,
          system_prompt: "Synthetic browser test",
          max_model_requests: 8,
          runtime: { image_ref: "antnest/antnest-runtime:local" },
        },
      });
      const created = await command("create", undefined, {
        ...agentBody,
        name: "Browser Agent",
        template_id: template.template_id,
      });
      const physical = await ready(created.agentID);
      console.log(
        JSON.stringify({
          status: "browser_ready",
          gateway: config.gateway,
          jaeger: config.jaeger,
          agent_id: created.agentID,
          organization: "stage3",
          email: "lifecycle-owner@example.com",
          password: "lifecycle-owner-password",
          uploads: directory,
          completion: "Send finish on stdin after browser checks",
        }),
      );
      const complete = await finished;
      abort.signal.throwIfAborted();
      assert(complete, "browser acceptance not finished");
      const response = await fetch(`${config.model}/status`, {
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
      });
      assert.equal(response.status, 200);
      const state = await response.json();
      assert.deepEqual(state.errors, []);
      assert.deepEqual(
        state.requests.map((r) => `${r.phase}:${r.stage}`),
        [
          "c4-browser-write:tool",
          "c4-browser-write:reply",
          "c4-browser-read:tool",
          "c4-browser-read:reply",
          "c4-browser-attachments:reply",
          "c4-browser-mobile:reply",
        ],
      );
      const bytes = await docker([
        "exec",
        "--user",
        "1000:1000",
        physical.container.Id,
        "base64",
        "-w",
        "0",
        "/workspace/.c4-browser-note",
      ]);
      assertWorkspaceBytes(bytes);
      return {
        model_requests: state.requests.length,
        completed_prompts: 4,
        workspace_bytes: "exact",
        trace_ids: [...new Set(state.requests.map((r) => r.trace_id))],
      };
    },
  );
} finally {
  clearTimeout(timer);
  input.close();
  try {
    if (config) await cleanup(config);
  } finally {
    if (directory) await rm(directory, { recursive: true });
  }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
abort.signal.throwIfAborted();
console.log(
  JSON.stringify({
    status: "passed",
    ...result,
    cleanup: "verified",
    browser_observations: "separate",
  }),
);
