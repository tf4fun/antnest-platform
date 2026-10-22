import assert from "node:assert/strict";
import { inspect } from "node:util";
import { pathToFileURL } from "node:url";
import {
  dockerClient,
  lines,
  scopeLabel,
} from "../lifecycle-closeout/docker.mjs";
import { writeEvidenceFile } from "../../support/storage.mjs";
import { waitForDeletedResources } from "./deletion-resources.mjs";

async function main() {
  const [project, directory] = process.argv.slice(2);
  assert.match(project ?? "", /^antnest-stage3-e2e-[0-9]+$/u);
  assert(directory, "Private deletion evidence directory is required");
  const suiteDeadline = Number(process.env.ANTNEST_E2E_DEADLINE_MS);
  assert(Number.isFinite(suiteDeadline), "Original suite deadline is required");
  const deadline = Math.min(suiteDeadline, Date.now() + 60_000);
  const controller = new AbortController();
  let signalExit;
  const stop = (signal, code) => {
    signalExit = code;
    controller.abort(new Error(`Deletion inspection received ${signal}`));
  };
  const interrupt = () => stop("SIGINT", 130);
  const terminate = () => stop("SIGTERM", 143);
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  const docker = dockerClient(
    process.env,
    controller.signal,
    Math.max(1, deadline - Date.now()),
  );
  const commands = [];
  const read = async (args, signal) => {
    const command = { args, started_at_ms: Date.now(), output: null };
    commands.push(command);
    command.output = await docker(args, false, { signal });
    command.completed_at_ms = Date.now();
    return lines(command.output);
  };
  try {
    const result = await waitForDeletedResources({
      deadline,
      signal: controller.signal,
      readInventory: async (signal) => ({
        observed_at_ms: Date.now(),
        containers: await read(
          ["ps", "-aq", "--filter", `label=${scopeLabel}=${project}`],
          signal,
        ),
        volumes: await read(
          ["volume", "ls", "-q", "--filter", `label=${scopeLabel}=${project}`],
          signal,
        ),
      }),
      preserve: async (evidence, failure) => {
        writeEvidenceFile(
          directory,
          "deletion-resources.private.json",
          JSON.stringify({ project, deadline, commands, ...evidence }) + "\n",
        );
        if (failure !== undefined)
          writeEvidenceFile(
            directory,
            "deletion-resources-failure.private.txt",
            inspect(
              { failure, operationError: evidence.operationError },
              { depth: 8 },
            ) + "\n",
          );
      },
    });
    console.log(
      JSON.stringify({ status: "deletion_resources_passed", ...result }),
    );
  } catch {
    console.error(
      JSON.stringify({
        status: "deletion_resources_failed",
        evidence: "deletion-resources.private.json",
      }),
    );
    process.exitCode = signalExit ?? 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  await main();
