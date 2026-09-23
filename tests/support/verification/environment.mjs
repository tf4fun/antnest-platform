import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { dockerClient } from "../../e2e/lifecycle-closeout/docker.mjs";
import { durablePath } from "../storage.mjs";

export function retainedState(row) {
  return {
    Id: row.Id,
    Name: row.Name,
    Image: row.Image,
    RestartCount: row.RestartCount,
    Mounts: [...row.Mounts].sort((a, b) =>
      JSON.stringify([a.Destination, a.Type, a.Source]).localeCompare(
        JSON.stringify([b.Destination, b.Type, b.Source]),
      ),
    ),
    StartedAt: row.State.StartedAt,
    Running: row.State.Running,
    Health: row.State.Health?.Status ?? null,
    Networks: Object.keys(row.NetworkSettings.Networks).sort(),
  };
}
export function compareEnvironment(before, after) {
  const resources = Object.fromEntries(
    Object.entries(before.resources).map(([key, values]) => [
      key,
      {
        added: after.resources[key].filter((x) => !values.includes(x)),
        removed: values.filter((x) => !after.resources[key].includes(x)),
      },
    ]),
  );
  const retained_changes = before.retained.flatMap((old) => {
    const current = after.retained.find((row) => row.Id === old.Id);
    return JSON.stringify(old) === JSON.stringify(current) ? [] : [old.Id];
  });
  const image_changes = Object.keys(before.images).filter(
    (reference) => before.images[reference] !== after.images[reference],
  );
  const unchanged =
    !retained_changes.length &&
    !image_changes.length &&
    !Object.values(resources).some(
      (delta) => delta.added.length || delta.removed.length,
    );
  return {
    unchanged,
    resource_counts: Object.fromEntries(
      Object.entries(after.resources).map(([key, items]) => [
        key,
        items.length,
      ]),
    ),
    resources,
    retained_count: after.retained.length,
    retained_changes,
    image_changes,
  };
}
export async function snapshotEnvironment({
  before,
  images = [],
  signal,
  docker = dockerClient(process.env, signal, 120000),
} = {}) {
  const resources = {};
  for (const [key, args] of Object.entries({
    containers: ["ps", "-aq", "--no-trunc"],
    volumes: ["volume", "ls", "-q"],
    networks: ["network", "ls", "-q", "--no-trunc"],
  }))
    resources[key] = (await docker(args)).split(/\s+/).filter(Boolean).sort();
  const ids = before
    ? before.retained
        .map((row) => row.Id)
        .filter((id) => resources.containers.includes(id))
    : resources.containers;
  const retained = ids.length
    ? JSON.parse(await docker(["inspect", ...ids]))
        .map(retainedState)
        .sort((a, b) => a.Id.localeCompare(b.Id))
    : [];
  const references = before
    ? Object.keys(before.images)
    : [...new Set([...images, ...retained.map((row) => row.Image)])];
  const actual = {};
  for (const reference of references) {
    try {
      actual[reference] = await docker([
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        reference,
      ]);
    } catch (error) {
      if (!before) throw error;
      actual[reference] = null;
    }
  }
  return { resources, retained, images: actual };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      output: { type: "string" },
      baseline: { type: "string" },
      image: { type: "string", multiple: true },
    },
  });
  assert(
    values.output && ["snapshot", "compare"].includes(positionals[0]),
    "expected snapshot|compare --output FILE [--baseline FILE] [--image REF]",
  );
  values.output = durablePath(values.output);
  const before = values.baseline
    ? JSON.parse(readFileSync(durablePath(values.baseline), "utf8"))
    : undefined;
  assert(
    positionals[0] !== "compare" || before,
    "comparison requires a baseline",
  );
  const after = await snapshotEnvironment({ before, images: values.image });
  writeFileSync(values.output, JSON.stringify(after, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  if (before) {
    const result = compareEnvironment(before, after);
    writeFileSync(
      `${values.output}.comparison.json`,
      JSON.stringify(result, null, 2),
      { flag: "wx", mode: 0o600 },
    );
    console.log(JSON.stringify(result));
    process.exitCode = result.unchanged ? 0 : 1;
  } else
    console.log(
      JSON.stringify({
        snapshot: true,
        containers: after.retained.length,
        images: Object.keys(after.images).length,
      }),
    );
}
