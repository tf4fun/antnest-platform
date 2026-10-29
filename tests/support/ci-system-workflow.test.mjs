import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ownership } from "./ci-impact.mjs";

const require = createRequire(
  new URL("../../services/agent-acp-service/package.json", import.meta.url),
);
const { parse } = require("yaml");
const root = fileURLToPath(new URL("../../", import.meta.url));
const workflow = (name) =>
  parse(readFileSync(resolve(root, `.github/workflows/${name}`), "utf8"));
const text = (name) =>
  readFileSync(resolve(root, `.github/workflows/${name}`), "utf8");

const e2e = workflow("e2e.yml");
const runImage = "github.event_name == 'pull_request' || !matrix.publish";
const suite = workflow("_suite.yml");
const integration = workflow("integration.yml");

test("the system E2E workflow runs on main, nightly, labeled pull requests and dispatch", () => {
  assert.deepEqual(Object.keys(e2e.jobs), [
    "plan",
    "images",
    "manifest",
    "suite",
    "result",
  ]);
  assert(e2e.on.push.branches.includes("main"));
  assert(e2e.on.pull_request.types.includes("labeled"));
  assert(Array.isArray(e2e.on.schedule) && e2e.on.schedule.length > 0);
  assert(e2e.on.workflow_dispatch);
  assert.doesNotMatch(text("e2e.yml"), /pull_request_target/u);
  assert.doesNotMatch(text("e2e.yml"), /Integration checks/u);
});

test("pull request runs require the e2e label and nothing else", () => {
  const condition = e2e.jobs.plan.if;
  assert.match(
    condition,
    /contains\(github\.event\.pull_request\.labels\.\*\.name, 'e2e'\)/u,
  );
  assert.match(condition, /github\.ref == 'refs\/heads\/main'/u);
});

test("PR checkouts never persist credentials and never publish to GHCR", () => {
  const imageSteps = e2e.jobs.images.steps;
  const checkouts = imageSteps.filter((item) =>
    item.uses?.startsWith("actions/checkout@"),
  );
  assert(checkouts.length > 0, "images job checks out");
  for (const step of checkouts)
    assert.equal(step.with["persist-credentials"], false);
  const privileged = (step) =>
    (step.if ?? "").includes("github.event_name != 'pull_request'") &&
    (step.if ?? "").includes("github.ref == 'refs/heads/main'");
  for (const step of imageSteps) {
    const uses = step.uses ?? "";
    const run = step.run ?? "";
    if (/login-action|docker push|Publish/u.test(uses + run))
      assert(privileged(step), step.name ?? uses);
  }
  assert(
    imageSteps.some(
      (step) => step.if === runImage && /docker save/u.test(step.run ?? ""),
    ),
    "PR and test images travel as artifacts, never packages",
  );
});

test("main publishes release images only; test images never reach GHCR", () => {
  const plan = e2e.jobs.plan.steps.find((step) => step.id === "plan");
  assert.doesNotMatch(plan.run, /--registry-images/u);
  const imageSteps = e2e.jobs.images.steps;
  for (const step of imageSteps) {
    const uses = step.uses ?? "";
    const run = step.run ?? "";
    if (/login-action|docker push/u.test(uses + run))
      assert.match(step.if ?? "", /&& matrix\.publish$/u, step.name ?? uses);
  }
  const upload = imageSteps.find((step) =>
    /upload-artifact/u.test(step.uses ?? ""),
  );
  assert.equal(upload.if, runImage);
});

test("a newer main merge cancels the superseded system run; nightly and replays finish", () => {
  const cancel = e2e.concurrency["cancel-in-progress"];
  assert.match(cancel, /github\.event_name == 'push' \|\|/u);
  assert.doesNotMatch(cancel, /schedule|workflow_dispatch/u);
  assert.match(e2e.concurrency.group, /github\.event_name/u);
  const record = e2e.jobs.result.steps.find((step) => step.id === "result");
  assert.match(record.run, /"cancelled"/u);
  const track = e2e.jobs.result.steps.find((step) =>
    /github-script/u.test(step.uses ?? ""),
  );
  assert.match(track.if, /!cancelled\(\)/u, "superseded runs open no issue");
});

test("a full passed main run is release-capable", () => {
  const record = e2e.jobs.result.steps.find((step) => step.id === "result");
  assert.match(record.run, /release_eligible: e2ePassed,/u);
  assert.match(record.run, /e2e_passed: e2ePassed,/u);
  assert.doesNotMatch(record.run, /legacy/u);
});

test("issue tracking and manifest publishing stay main-only privileged steps", () => {
  for (const step of e2e.jobs.result.steps.filter((item) =>
    /github-script/u.test(item.uses ?? ""),
  )) {
    assert.match(step.if, /github\.event_name != 'pull_request'/u);
    assert.match(step.if, /github\.ref == 'refs\/heads\/main'/u);
  }
  const upload = e2e.jobs.manifest.steps.find((step) =>
    /upload-artifact/u.test(step.uses ?? ""),
  );
  assert(upload, "the manifest persists as an artifact, never a tag");
  assert.equal(upload.with.name, "version-manifest");
});

test("the suite harness checks out the exact revision with manifest images", () => {
  assert(e2e.jobs.suite.uses.endsWith("_suite.yml"));
  assert.equal(
    e2e.jobs.suite.with.revision,
    "${{ needs.plan.outputs.revision }}",
  );
  assert.equal(
    e2e.jobs.suite.with.images,
    "${{ needs.manifest.outputs.images }}",
    "suite images come from the frozen manifest",
  );
  assert.match(
    e2e.jobs.suite.with["readiness-rounds"],
    /schedule' && '100' \|\| '3'/u,
  );
  for (const input of ["suite", "images", "revision", "readiness-rounds"])
    assert(
      Object.hasOwn(suite.on.workflow_call.inputs, input),
      `_suite input ${input}`,
    );
  const checkout = suite.jobs.run.steps.find((step) =>
    /checkout/u.test(step.uses ?? ""),
  );
  assert.match(
    checkout["actions/checkout"]?.with?.ref ?? checkout.with?.ref ?? "",
    /inputs\.revision/u,
    "the suite checks out the resolved revision",
  );
  const run = suite.jobs.run.steps.find((step) =>
    /ci-shard\.mjs/u.test(step.run ?? ""),
  );
  assert.match(run.env.ANTNEST_E2E_READINESS_ROUNDS, /readiness-rounds/u);
});

test("the component gate selects component scope only and keeps its required name", () => {
  assert.deepEqual(
    new Set(integration.jobs.integration.needs),
    new Set([
      "changes",
      "images",
      "suite",
      "image-suite",
      ...[
        "admin-console",
        "agent-acp-service",
        "agent-controller",
        "agent-ui",
        "antnest-runtime",
        "edge-gateway",
        "identity-service",
        "runtime-controller",
        "runtime-egress",
        "skill-registry",
      ].map((name) => `unit-${name}`),
    ]),
    "the required gate depends on every selected unit job",
  );
  assert(!Object.keys(integration.jobs).some((job) => /optional/u.test(job)));
  const select = integration.jobs.changes.steps.find(
    (step) => step.id === "select",
  );
  assert.match(select.run, /--scope component/u);
  const e2ePlan = e2e.jobs.plan.steps.find((step) => step.id === "plan");
  assert.match(e2ePlan.run, /--scope e2e/u);
});

test("service workflows scope contract paths to declared consumers and guard image jobs", () => {
  const map = ownership(root);
  const files = new Map();
  for (const file of readdirSync(resolve(root, ".github/workflows")))
    if (file.endsWith(".yml")) files.set(file, workflow(file));
  for (const parsed of files.values())
    for (const event of ["pull_request", "push"]) {
      const paths = parsed.on?.[event]?.paths ?? [];
      assert(
        !paths.includes("contracts/**"),
        `${parsed.name} falls back to every contract`,
      );
    }
  for (const [dir, services] of Object.entries(map))
    for (const service of services) {
      const file = `${service === "antnest-runtime" ? "runtime" : service}.yml`;
      const parsed = files.get(file);
      assert(parsed, `${service} has no workflow`);
      const paths = parsed.on.pull_request?.paths ?? [];
      assert(
        paths.includes(`contracts/${dir}/**`),
        `${file} misses contracts/${dir}/** for declared consumer ${service}`,
      );
    }
  for (const [file, parsed] of files)
    for (const [job, body] of Object.entries(parsed.jobs ?? {}))
      if (/_image\.yml/u.test(body.uses ?? ""))
        assert.match(
          body.if ?? "",
          /github\.event_name != 'pull_request'/u,
          `${file} job ${job} publishes on pull requests`,
        );
});

test("the repository gate always validates contract ownership", () => {
  const ci = text("ci.yml");
  assert.match(ci, /node tests\/support\/ci-impact\.mjs --check/u);
});

test("reused unit workflows isolate concurrency and skip direct pull requests", () => {
  const groups = new Set();
  for (const name of [
    "admin-console",
    "agent-acp-service",
    "agent-controller",
    "agent-ui",
    "runtime",
    "edge-gateway",
    "identity-service",
    "runtime-controller",
    "runtime-egress",
    "skill-registry",
  ]) {
    const parsed = workflow(`${name}.yml`);
    const group = parsed.concurrency?.group ?? "";
    assert(group.length > 0, `${name} concurrency`);
    assert(!groups.has(group), `${name} duplicates a group`);
    groups.add(group);
    assert.notEqual(group, "${{ github.workflow }}-${{ github.ref }}");
    assert(
      parsed.on.workflow_call !== undefined ||
        Object.hasOwn(parsed.on, "workflow_call"),
      `${name} accepts reusable calls`,
    );
    for (const body of Object.values(parsed.jobs ?? {})) {
      if (/_image\.yml/u.test(body.uses ?? "")) continue;
      if (body.if === undefined) continue;
      const condition = String(body.if);
      if (condition.includes("pull_request"))
        assert.match(
          condition,
          /github\.workflow == 'integration'/u,
          `${name} check job must allow integration calls`,
        );
    }
  }
});
