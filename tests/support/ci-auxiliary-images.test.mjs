import assert from "node:assert/strict";
import test from "node:test";
import {
  matrices,
  matrixEntry,
  shardEntry,
  shards,
  setups,
  suites,
} from "./ci-changes.mjs";

const collector = "cr.jaegertracing.io/jaegertracing/jaeger:2.21.0";
const platformPull = [
  "postgres:17.11-bookworm",
  "node:24.21.0-bookworm-slim",
  "temporalio/admin-tools:1.32.0",
  collector,
];
const unique = (values) => [...new Set(values)].sort();

function tokens(value) {
  assert.equal(
    typeof value,
    "string",
    "image inventories must remain scalar strings",
  );
  if (value === "") return [];
  const result = value.split(" ");
  assert.ok(
    result.every((image) => image.length > 0),
    "image inventory must not contain empty tokens",
  );
  return result;
}

function partition(entry, original) {
  const required = tokens(entry.pull);
  const auxiliary = tokens(entry.auxiliary_pull);
  assert.ok(
    required.every((image) => image !== collector),
    "the exact collector must not block required pulling",
  );
  assert.deepEqual(
    auxiliary,
    original.includes(collector) ? [collector] : [],
    "only the exact known collector may enter auxiliary_pull",
  );
  assert.ok(
    auxiliary.every((image) => !required.includes(image)),
    "required and auxiliary inventories must be disjoint",
  );
  assert.deepEqual(
    unique([...required, ...auxiliary]),
    unique(original),
    "partitioning must preserve the complete original image inventory",
  );
}

function scalar(entry) {
  for (const [name, value] of Object.entries(entry))
    assert.ok(
      typeof value === "string" || typeof value === "boolean",
      `${name} must remain a matrix scalar`,
    );
  assert.equal(typeof entry.auxiliary_pull, "string");
  assert.deepEqual(JSON.parse(JSON.stringify(entry)), entry);
}

function example(id, pull) {
  return {
    id,
    name: `Fixture ${id}`,
    tier: "c",
    setup: ["go", "chromium"],
    images: ["agent-ui"],
    paths: ["tests/support/**"],
    run: [`make ${id}`, `node ${id}.mjs`],
    strict: true,
    ...(pull === undefined ? {} : { pull }),
  };
}

function freeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

test("the actual skill-learning member retains its full inventory and emits only its collector as auxiliary", () => {
  const suite = suites.find((row) => row.id === "c-skill-learning-cleanup");
  assert.ok(suite && !suite.disabled);
  const before = structuredClone(suite);
  assert.deepEqual(suite.pull, platformPull);
  const entry = matrixEntry(suite);
  assert.equal(
    entry.pull,
    platformPull.filter((image) => image !== collector).join(" "),
  );
  assert.equal(entry.auxiliary_pull, collector);
  partition(entry, platformPull);
  scalar(entry);
  assert.deepEqual(suite, before);
});

test("the actual skill-learning shard unions and deduplicates complete member inventories", () => {
  const shard = shards.find((row) => row.id === "c-skill-learning");
  assert.ok(shard);
  const members = shard.suites.map((id) => {
    const suite = suites.find((row) => row.id === id);
    assert.ok(
      suite && !suite.disabled,
      `missing enabled skill-learning member ${id}`,
    );
    assert.deepEqual(suite.pull, platformPull);
    return suite;
  });
  const before = structuredClone({ shard, members });
  const entry = shardEntry(shard, members);
  assert.equal(
    entry.pull,
    unique(platformPull.filter((image) => image !== collector)).join(" "),
  );
  assert.equal(entry.auxiliary_pull, collector);
  partition(
    entry,
    members.flatMap((suite) => suite.pull),
  );
  assert.deepEqual(
    JSON.parse(entry.suites),
    members.map((suite) => ({
      id: suite.id,
      name: suite.name,
      run: suite.run.join("\n"),
      strict: suite.strict === true,
    })),
  );
  scalar(entry);
  assert.deepEqual({ shard, members }, before);
});

test("suite transport gains one scalar field while all other flags and unrelated image references retain their meaning", () => {
  const unknown = [
    "cr.jaegertracing.io/jaegertracing/jaeger:2.21.1",
    "cr.jaegertracing.io/jaegertracing/jaeger:2.21.0-other",
    `cr.jaegertracing.io/jaegertracing/jaeger@sha256:${"a".repeat(64)}`,
    "other.registry/jaegertracing/jaeger:2.21.0",
    "registry.example/business-runtime:7",
  ];
  const inventory = ["postgres:17.11-bookworm", collector, ...unknown];
  const suite = freeze(example("mixed-images", inventory));
  const before = structuredClone(suite);
  const entry = matrixEntry(suite);
  assert.deepEqual(entry, {
    id: suite.id,
    name: suite.name,
    tier: "C",
    run: suite.run.join("\n"),
    images: "agent-ui",
    pull: [inventory[0], ...unknown].join(" "),
    auxiliary_pull: collector,
    strict_exit: true,
    ...Object.fromEntries(
      setups.map((setup) => [
        `setup_${setup.replaceAll("-", "_")}`,
        suite.setup.includes(setup),
      ]),
    ),
  });
  partition(entry, inventory);
  scalar(entry);
  assert.deepEqual(suite, before);
});

test("shard partitioning deduplicates overlapping required images and the collector without making unknown images auxiliary", () => {
  const unrelatedCollector = "cr.jaegertracing.io/jaegertracing/jaeger:2.21.1";
  const members = freeze([
    example("first", [
      collector,
      "postgres:17.11-bookworm",
      unrelatedCollector,
    ]),
    example("second", [
      "postgres:17.11-bookworm",
      collector,
      "temporalio/admin-tools:1.32.0",
    ]),
    example("third", [
      "registry.example/required:1",
      unrelatedCollector,
      "registry.example/required:1",
    ]),
  ]);
  const shard = freeze({
    id: "c-fixture",
    name: "Fixture shard",
    suites: members.map((suite) => suite.id),
  });
  const before = structuredClone({ shard, members });
  const inventory = members.flatMap((suite) => suite.pull);
  const entry = shardEntry(shard, members);
  assert.equal(
    entry.pull,
    unique(inventory.filter((image) => image !== collector)).join(" "),
  );
  assert.equal(entry.auxiliary_pull, collector);
  assert.equal(tokens(entry.pull).length, new Set(tokens(entry.pull)).size);
  partition(entry, inventory);
  scalar(entry);
  assert.deepEqual({ shard, members }, before);
});

for (const [label, pull] of [
  ["absent", undefined],
  ["empty", []],
  ["required-only", ["postgres:17.11-bookworm"]],
]) {
  test(`a ${label} suite inventory emits an empty auxiliary scalar and preserves required pulling`, () => {
    const suite = freeze(example(`without-collector-${label}`, pull));
    const before = structuredClone(suite);
    const entry = matrixEntry(suite);
    assert.equal(entry.auxiliary_pull, "");
    assert.equal(entry.pull, (pull ?? []).join(" "));
    partition(entry, pull ?? []);
    scalar(entry);
    assert.deepEqual(suite, before);
  });
}

test("every enabled suite keeps its complete source inventory through matrix entry emission", () => {
  const enabled = suites.filter((suite) => !suite.disabled);
  assert.ok(enabled.length > 0);
  const before = structuredClone(enabled);
  for (let index = 0; index < enabled.length; index++) {
    const suite = enabled[index];
    const original = before[index].pull ?? [];
    const entry = matrixEntry(suite);
    assert.equal(
      entry.pull,
      original.filter((image) => image !== collector).join(" "),
      suite.id,
    );
    partition(entry, original);
    scalar(entry);
    assert.deepEqual(
      suite,
      before[index],
      `${suite.id} source inventory or metadata changed`,
    );
  }
  assert.deepEqual(enabled, before);
});

test("all emitted matrices preserve selected suite coverage, original shard inventories and scalar transport", () => {
  const selected = suites.filter((suite) => !suite.disabled);
  const before = structuredClone(selected);
  const expectedById = new Map(before.map((suite) => [suite.id, suite]));
  const result = matrices(selected);
  assert.deepEqual(Object.keys(result).sort(), ["imaged", "optional", "plain"]);
  const rows = [
    ...result.plain.include,
    ...result.imaged.include,
    ...result.optional.include,
  ];
  const emitted = [];
  for (const entry of rows) {
    const shard = shards.find((row) => row.id === entry.id);
    assert.ok(shard, `unknown emitted shard ${entry.id}`);
    const members = shard.suites
      .filter((id) => expectedById.has(id))
      .map((id) => expectedById.get(id));
    const inventory = members.flatMap((suite) => suite.pull ?? []);
    const payload = members.map((suite) => ({
      id: suite.id,
      name: suite.name,
      run: suite.run.join("\n"),
      strict: suite.strict === true,
    }));
    assert.deepEqual(JSON.parse(entry.suites), payload);
    assert.equal(
      entry.pull,
      unique(inventory.filter((image) => image !== collector)).join(" "),
      entry.id,
    );
    assert.equal(
      entry.images,
      unique(members.flatMap((suite) => suite.images ?? [])).join(","),
    );
    partition(entry, inventory);
    scalar(entry);
    emitted.push(...payload.map((suite) => suite.id));
  }
  assert.equal(
    new Set(emitted).size,
    emitted.length,
    "each selected suite must be emitted once",
  );
  assert.deepEqual([...emitted].sort(), before.map((suite) => suite.id).sort());
  assert.ok(rows.some((entry) => entry.auxiliary_pull === collector));
  assert.ok(rows.some((entry) => entry.auxiliary_pull === ""));
  assert.deepEqual(selected, before);
});

test("empty selection retains the original three empty matrix envelopes", () => {
  assert.deepEqual(matrices([]), {
    plain: { include: [] },
    imaged: { include: [] },
    optional: { include: [] },
  });
});
