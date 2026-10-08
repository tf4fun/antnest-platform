// Selects the integration suites a change set must run. The integration
// workflow always runs; its suite job consumes the matrix printed here.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// Any change here can alter every suite's environment or selection.
const everySuite = [
  ".github/workflows/integration.yml",
  ".github/workflows/_suite.yml",
  "tests/support/**",
  "contracts/**",
  "Makefile",
  ".nvmrc",
  ".dockerignore",
];
const go = ["go.work", "go.work.sum", "modules/**", ".golangci.yml"];
const rust = ["rust-toolchain.toml"];
const compose = [
  "compose*.yaml",
  ".env.example",
  "scripts/**",
  "tests/e2e/lifecycle-closeout/**",
];
const service = (...names) => names.map((name) => `services/${name}/**`);
const runtime = ["runtimes/antnest-runtime/**", ...rust];

// Compose dependencies start with --pull never, so third-party images are
// pulled before the suite runs. A suite with a pull list is a Docker suite and
// gets the pinned Docker Engine.
const base = ["postgres:17.11-bookworm", "node:24.21.0-bookworm-slim"];
const temporal = [...base, "temporalio/admin-tools:1.32.0"];
// Platform stacks start every service from antnest/<image>:local.
const platformImages = [
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
  "temporal",
];
const observed = [
  ...temporal,
  "cr.jaegertracing.io/jaegertracing/jaeger:2.21.0",
];

// Prose never changes test behavior; contract and test sources may be parsed.
const ignored = ["**/*.md", "LICENSE"];
const parsedProse = ["contracts/**", "tests/**"];

// A `disabled` suite is never selected; the reason names the known breakage.
// `images` are prebuilt as antnest/<image>:local before `run`, for runners
// that start them with `--no-build` or inspect them without building.
export const suites = [
  {
    id: "egress-postgres",
    name: "Runtime Egress PostgreSQL",
    tier: "a",
    setup: ["rust"],
    paths: [
      ...service("runtime-egress"),
      "tests/integration/runtime-egress/**",
      ...rust,
      ...compose,
    ],
    pull: base,
    run: ["make test-egress-postgres"],
  },
  {
    id: "runtime-controller-postgres",
    name: "Runtime Controller PostgreSQL",
    tier: "a",
    setup: ["go"],
    paths: [
      ...service("runtime-controller"),
      "tests/integration/go/runtime-controller/**",
      ...go,
      ...compose,
    ],
    pull: base,
    run: ["make test-runtime-controller-postgres"],
  },
  {
    id: "identity-postgres",
    name: "Identity Service PostgreSQL",
    tier: "a",
    setup: ["go"],
    paths: [
      ...service("identity-service"),
      "tests/integration/go/identity-service/**",
      ...go,
      ...compose,
    ],
    pull: base,
    run: ["make test-identity-postgres"],
  },
  {
    id: "agent-controller-postgres",
    name: "Agent Controller PostgreSQL and Temporal",
    tier: "a",
    setup: ["go"],
    paths: [
      ...service("agent-controller"),
      "tests/integration/go/agent-controller/**",
      ...go,
      ...compose,
    ],
    images: ["temporal"],
    pull: temporal,
    run: ["make test-agent-controller-postgres"],
  },
  {
    id: "agent-acp-postgres",
    name: "Agent ACP PostgreSQL and audit",
    tier: "a",
    setup: [],
    paths: [
      ...service("agent-acp-service"),
      "tests/integration/agent-acp-service/**",
      ...compose,
    ],
    pull: base,
    run: ["make test-agent-acp-postgres", "make test-agent-acp-audit"],
  },
  {
    id: "admin-console-browser",
    name: "Admin Console browser",
    tier: "a",
    setup: ["admin-web", "chromium"],
    paths: [...service("admin-console"), "tests/integration/admin-console/**"],
    run: [
      "npm --prefix services/admin-console/web run build",
      "npm --prefix services/admin-console/web run test:browser:catalog",
      "npm --prefix services/admin-console/web run test:browser:audit",
      "npm --prefix services/admin-console/web run test:browser:skills",
      "npm --prefix services/admin-console/web run test:browser:template-skills",
      "npm --prefix services/admin-console/web run test:browser:managed-mcp-secrets",
    ],
  },
  {
    id: "agent-ui-browser",
    name: "Agent UI browser",
    tier: "a",
    setup: ["agent-ui-web", "chromium"],
    paths: [...service("agent-ui"), "tests/integration/agent-ui/**"],
    run: ["npm --prefix services/agent-ui/web run test:browser"],
  },
  {
    id: "deployment-contracts",
    name: "Deployment render contracts",
    tier: "a",
    setup: ["go"],
    paths: [
      "services/**",
      "runtimes/**",
      "tests/integration/**",
      "tests/e2e/**",
      ...go,
      ...compose,
    ],
    run: [
      "make test-deployment-wiring",
      "make test-deployment-ports",
      "make test-deployment-transports",
      "make test-service-authentication",
      "make test-service-authentication-integration",
      "make test-skill-deployment",
    ],
  },
  {
    id: "elicitation-sdk-probe",
    name: "Runtime elicitation SDK probe",
    tier: "a",
    setup: ["rust"],
    paths: ["tests/integration/antnest-runtime/sdk-probes/**", ...runtime],
    run: [
      "cargo test --locked --manifest-path tests/integration/antnest-runtime/sdk-probes/elicitation/Cargo.toml",
    ],
  },
  ...[
    ["console", "Admin Console", service("admin-console")],
    ["controller", "Agent Controller", service("agent-controller")],
    [
      "egress",
      "Runtime Egress",
      [...service("runtime-egress"), "tests/integration/runtime-egress/**"],
    ],
    ["gateway", "Edge Gateway", service("edge-gateway")],
    ["identity", "Identity Service", service("identity-service")],
    ["runtime-controller", "Runtime Controller", service("runtime-controller")],
    ["runtime", "Runtime instance", runtime],
  ].map(([name, title, paths]) => ({
    id: `auth-${name}`,
    name: `${title} service authentication`,
    tier: "b",
    setup: [],
    images: {
      controller: ["temporal"],
      "runtime-controller": ["antnest-runtime"],
      runtime: [
        "antnest-runtime",
        "antnest-runtime-fixture",
        "antnest-runtime-skill-gate",
      ],
    }[name],
    pull: name === "controller" ? temporal : base,
    paths: [
      ...paths,
      `tests/e2e/service-authentication/${name}/**`,
      ...compose,
    ],
    run: [`node tests/e2e/service-authentication/${name}/run.mjs`],
  })),
  {
    id: "deployment-docker",
    name: "Deployment credentials, PKI and ports",
    tier: "b",
    setup: [],
    paths: [
      "tests/e2e/service-authentication/deployment-credentials/**",
      "tests/e2e/service-authentication/deployment-ports/**",
      "tests/e2e/service-authentication/development-pki/**",
      "tests/integration/deployment/**",
      ...compose,
    ],
    images: ["temporal"],
    pull: temporal,
    run: [
      "node tests/e2e/service-authentication/deployment-credentials/run.mjs",
      "node tests/e2e/service-authentication/development-pki/run.mjs",
      "make e2e-deployment-ports",
    ],
  },
  {
    id: "deployment-transports",
    name: "Deployment transports",
    tier: "b",
    setup: [],
    paths: ["tests/integration/deployment/**", ...compose],
    pull: base,
    run: ["make e2e-deployment-transports"],
  },
  {
    id: "observation-retry",
    name: "Runtime Controller observation retry",
    tier: "b",
    setup: [],
    images: [
      "agent-acp-service",
      "antnest-runtime",
      "runtime-controller",
      "runtime-egress",
    ],
    pull: base,
    paths: [
      ...service("runtime-controller", "runtime-egress", "agent-acp-service"),
      ...runtime,
      "tests/e2e/runtime-controller/**",
      ...go,
      ...compose,
    ],
    run: ["make e2e-runtime-controller-observation-retry"],
  },
  ...[
    ["stage1", "Authenticated shell stage 1", ["runtime-egress"]],
    [
      "runtime-controller",
      "Authenticated shell Runtime Controller",
      ["runtime-egress", "runtime-controller"],
    ],
  ].map(([mode, name, owners]) => ({
    id: `shell-${mode}`,
    name,
    tier: "b",
    setup: [],
    pull: base,
    paths: [
      ...service(...owners),
      ...runtime,
      "tests/e2e/e2e-stage1.sh",
      "tests/e2e/runtime-controller/**",
      ...go,
      ...compose,
    ],
    images: ["antnest-runtime", ...owners].sort(),
    run: [`node tests/support/authenticated-shell-e2e.mjs ${mode}`],
  })),
  ...[
    [
      "gateway-security-headers",
      "Edge Gateway security headers",
      ["agent-ui-web", "chromium"],
      "make e2e-gateway-security-headers",
    ],
    [
      "agent-ui-receipt",
      "Agent UI receipt contract",
      ["agent-ui-web", "chromium"],
      "make e2e-agent-ui-receipt-contract",
    ],
  ].map(([id, name, setup, run, disabled]) => ({
    id,
    name,
    tier: "b",
    setup,
    disabled,
    images: platformImages,
    pull: temporal,
    paths: [
      "services/**",
      ...runtime,
      "tests/e2e/edge-gateway/**",
      "tests/e2e/agent-ui/**",
      "tests/e2e/workspace-closeout/**",
      "tests/e2e/acp-multimodal/**",
      "tests/e2e/identity-closeout/**",
      ...go,
      ...compose,
    ],
    run: [run],
  })),
  {
    id: "skill-registry-discovery",
    name: "Skill Registry discovery",
    tier: "b",
    setup: [],
    images: ["skill-registry"],
    pull: base,
    paths: [
      ...service("skill-registry"),
      "tests/e2e/skill-registry/**",
      "tests/e2e/service-authentication/registry/**",
      ...go,
      ...compose,
    ],
    run: [
      "make e2e-skill-discovery-registry",
      "make e2e-skill-discovery-caller-registry",
      "make e2e-skill-registry-trace",
    ],
  },
  {
    id: "skill-registry-rc-prepare",
    name: "Skill Registry to Runtime Controller preparation",
    tier: "b",
    setup: ["go"],
    pull: base,
    paths: [
      ...service("skill-registry", "runtime-controller"),
      "tests/integration/skill-registry/**",
      "tests/e2e/service-authentication/registry/**",
      ...go,
    ],
    run: [
      "make integration-stage4-skill-prepare",
      "make integration-stage4-skill-slow-prepare",
      "make integration-stage4-skill-restart-prepare",
    ],
  },
  {
    id: "deployment-wiring",
    name: "Deployment Compose wiring",
    tier: "b",
    setup: [],
    images: platformImages,
    pull: observed,
    paths: [
      "services/**",
      "tests/integration/deployment/**",
      ...go,
      ...compose,
    ],
    run: ["make e2e-deployment-wiring"],
  },
  ...[1, 2].map((version) => ({
    id: `managed-mcp-secrets-v${version}`,
    name: `Managed MCP secrets protocol v${version}`,
    tier: "b",
    setup: [],
    images: [...platformImages, "antnest-runtime-managed"].sort(),
    pull: observed,
    paths: [
      "services/**",
      ...runtime,
      "tests/e2e/managed-mcp/**",
      ...go,
      ...compose,
    ],
    run: [`make e2e-managed-mcp-v${version}`],
  })),
  {
    id: "skill-registry-console",
    name: "Skill Registry Admin Console discovery",
    tier: "b",
    setup: ["admin-web", "chromium"],
    images: ["admin-console", "skill-registry"],
    pull: base,
    paths: [
      ...service("skill-registry", "admin-console"),
      "tests/e2e/skill-registry/**",
      "tests/integration/admin-console/**",
      ...go,
      ...compose,
    ],
    run: ["make e2e-skill-discovery-console"],
  },
  {
    id: "skill-temporary-runtime",
    name: "Skill Registry temporary runtime",
    tier: "b",
    setup: [],
    images: ["antnest-runtime"],
    pull: base,
    paths: [
      ...runtime,
      "tests/e2e/skill-registry/**",
      "tests/e2e/antnest-runtime/**",
    ],
    run: ["make e2e-skill-temporary-runtime"],
  },
  {
    id: "skill-learning-runtime",
    name: "Skill learning Runtime install",
    tier: "b",
    setup: [],
    images: [
      "antnest-runtime",
      "antnest-runtime-fixture",
      "antnest-runtime-skill-gate",
    ],
    pull: base,
    paths: [...runtime, "tests/e2e/skill-learning/**"],
    run: ["make e2e-skill-learning-runtime"],
  },
  ...tierC(),
];

// Tier C: whole-platform scenarios whose rule spans services. Every target
// boots its own stack (many are deliberately destructive), so each is one
// suite. They report outside `Integration checks` until they are stable.
// Foundation runners exit 2 when business and topology pass but strict trace
// findings remain. They run without make, which reports every failed recipe
// as 2.
function foundation(runner) {
  return { run: `node tests/e2e/${runner}`, strict: true };
}

// Stage 3a profiles that report strict-only trace findings (expected
// rejection errors, clock skew) as exit 2 run the make recipe directly so
// that exit code survives.
function stage3aProfile(profile) {
  return { run: `${profile} sh tests/e2e/e2e-stage3a.sh`, strict: true };
}

function tierC() {
  const families = {
    "Stage 3a": [
      ["e2e-stage3-local", "base"],
      ...[
        "acp-restart",
        "file-observations",
        "multimodal",
        "rpc-response-loss",
        "session-cost",
        "slash-commands",
        "stage3-skill-delivery",
        "stage4-skill-offline-reuse",
        "stage4-skill-registry-outage",
        "stage4-skill-restart-rebuild",
        "structured-plan",
      ].map((name) => [`e2e-${name}`, name]),
      ...[
        ["acp-closeout", "ANTNEST_E2E_ACP_CLOSEOUT=true"],
        ["acp-session", "ANTNEST_E2E_ACP_SESSION=true"],
        ["agent-access", "ANTNEST_E2E_AGENT_ACCESS=true"],
        ["identity-access", "ANTNEST_E2E_IDENTITY_ACCESS=true"],
        ["identity-core", "ANTNEST_E2E_IDENTITY_CORE=true"],
        [
          "organization-display",
          "ANTNEST_E2E_IDENTITY_CORE=true ANTNEST_E2E_ORGANIZATION_DISPLAY=true",
          { browser: true },
        ],
      ].map(([name, profile, options]) => [
        `e2e-${name}`,
        name,
        { ...options, ...stage3aProfile(profile) },
      ]),
      ...[
        ["tool-permissions", "ANTNEST_E2E_TOOL_PERMISSIONS=true"],
        ["tool-progress", "ANTNEST_E2E_TOOL_PROGRESS=true"],
      ].map(([name, profile]) => [
        `e2e-${name}`,
        name,
        {
          before: ["make docker-build-managed-runtime"],
          images: [...platformImages, "antnest-runtime-managed"].sort(),
          ...stage3aProfile(profile),
        },
      ]),
    ],
    "Authenticated shell": [
      ["e2e-stage2", "stage 2"],
      ["e2e-lifecycle", "lifecycle"],
    ],
    Lifecycle: [
      ...[
        ["lifecycle-loss", "run.mjs loss"],
        ["lifecycle-restore", "run.mjs restore"],
        ["lifecycle-shutdown", "run.mjs shutdown"],
        ["stage4-skill-restore", "run.mjs skill-restore"],
      ].map(([name, runner]) => [
        `e2e-${name}`,
        name,
        foundation(`lifecycle-closeout/${runner}`),
      ]),
      ["e2e-stage4-skill-storage-restore", "stage4-skill-storage-restore"],
    ],
    Workspace: [
      ["e2e-workspace", "workspace", foundation("workspace-closeout/run.mjs")],
      [
        "e2e-workspace-browser",
        "browser",
        { browser: true, ...foundation("workspace-closeout/browser-run.mjs") },
      ],
    ],
    "Skill learning": [
      // The make target rebuilds antnest/antnest-runtime:local first.
      [
        "e2e-runtime-tool-usability",
        "runtime tool usability",
        {
          run: "ANTNEST_E2E_SKILL_LEARNING_DEBUG=true ANTNEST_E2E_TOOL_USABILITY=true node --test --test-concurrency=1 tests/e2e/skill-learning/automatic-flow.test.mjs",
        },
      ],
      ...[
        "service-authentication-integration",
        "skill-discovery-caller",
        "skill-learning-browser",
        "skill-source-lifecycle",
      ].map((name) => [`e2e-${name}`, name, { browser: true }]),
      ...[
        "skill-learning-cleanup",
        "skill-learning-install-after-rename-disable",
        "skill-learning-install-after-rename-foreground",
        "skill-learning-install-held-disable",
        "skill-learning-install-held-foreground",
        "skill-learning-install-lost",
        "skill-learning-install-pre-dispatch-disable",
        "skill-learning-key-compromise",
        "skill-learning-key-rotation",
        "skill-learning-lifecycle-rebuild",
        "skill-learning-restart",
      ].map((name) => [
        `e2e-${name}`,
        name,
        name.startsWith("skill-learning-install-")
          ? {
              images: [...platformImages, "antnest-runtime-skill-gate"].sort(),
            }
          : {},
      ]),
    ],
  };
  return Object.entries(families).flatMap(([family, targets]) =>
    targets.map(([target, name, options = {}]) => ({
      id: target.replace(/^e2e-/u, "c-"),
      name: `${family}: ${name}`,
      tier: "c",
      setup: options.browser ? ["agent-ui-web", "chromium"] : [],
      images: options.images ?? platformImages,
      pull: observed,
      paths: ["services/**", ...runtime, "tests/e2e/**", ...go, ...compose],
      run: [...(options.before ?? []), options.run ?? `make ${target}`],
      ...(options.strict ? { strict: true } : {}),
    })),
  );
}

// Platform targets kept out of CI until the issue lands: each tests one
// service's rule through the whole stack and moves to that service's
// component tests, or its behavior is not settled. The issue deletes the
// target or re-admits it.
export const outsideCI = {
  "e2e-acp-persistence": 167,
  "e2e-lifecycle-health": 168,
  "e2e-lifecycle-interrupted": 166,
  "e2e-lifecycle-network": 168,
  "e2e-skill-learning-diagnostics-browser": 169,
  "e2e-skill-learning-lifecycle-disable": 167,
  "e2e-skill-learning-model-failure": 167,
  "e2e-skill-learning-model-recovery": 167,
  "e2e-skill-learning-notice-send-failure": 167,
  "e2e-skill-learning-pinned": 167,
  "e2e-skill-learning-policy-off": 167,
  "e2e-skill-learning-preempt": 167,
  "e2e-skill-learning-skip": 167,
  "e2e-skill-learning-ui-outage": 169,
  "e2e-skill-learning-untrusted-only": 167,
  "e2e-stage4-skill-fenced-invalidation": 166,
  "e2e-stage4-skill-initialize-race": 165,
  "e2e-stage4-skill-mount-race": 165,
  "e2e-stage4-skill-mount-response-loss": 165,
  "e2e-stage4-skill-ready-drift": 165,
  "e2e-stage4-skill-ready-loss": 165,
  "e2e-stage4-skill-start-response-loss": 165,
  "e2e-stage4-skill-target-drift": 165,
};

export const setups = ["go", "rust", "admin-web", "agent-ui-web", "chromium"];

export const images = {
  "antnest-runtime": "runtimes/antnest-runtime/Dockerfile",
  "runtime-egress": "services/runtime-egress/Dockerfile",
  "runtime-controller": "services/runtime-controller/Dockerfile",
  "agent-acp-service": "services/agent-acp-service/Dockerfile",
  "identity-service": "services/identity-service/Dockerfile",
  "agent-controller": "services/agent-controller/Dockerfile",
  "skill-registry": "services/skill-registry/Dockerfile",
  "admin-console": "services/admin-console/Dockerfile",
  "agent-ui": "services/agent-ui/Dockerfile",
  "edge-gateway": "services/edge-gateway/Dockerfile",
  temporal: "scripts/temporal/Dockerfile",
  // Runtime test variants. Runners derive their candidates from these
  // (tests/support/candidate-images.mjs) instead of rebuilding the Runtime.
  // A context replaces the base image a Dockerfile names by default with a
  // stage of another image's Dockerfile.
  "antnest-runtime-fixture": {
    dockerfile: "tests/e2e/managed-mcp/fixture.Dockerfile",
    contexts: {
      "antnest/antnest-runtime:managed-build": {
        image: "antnest-runtime",
        target: "build",
      },
    },
  },
  "antnest-runtime-managed": {
    dockerfile: "tests/e2e/managed-mcp/Dockerfile",
    contexts: {
      "antnest/antnest-runtime:managed-build": {
        image: "antnest-runtime",
        target: "build",
      },
      "antnest/antnest-runtime:local": { image: "antnest-runtime" },
    },
  },
  "antnest-runtime-skill-gate": {
    dockerfile: "runtimes/antnest-runtime/Dockerfile",
    target: "e2e",
    args: { ANTNEST_RUNTIME_FEATURES: "skill-maintenance-e2e-gate" },
  },
};

export function imageSpec(name) {
  if (!Object.hasOwn(images, name)) throw new Error(`unknown image ${name}`);
  const spec = images[name];
  return typeof spec === "string" ? { dockerfile: spec } : spec;
}

const isVariant = (name) => typeof images[name] !== "string";

const registry = "ghcr.io/tf4fun";
const packageName = (name) =>
  name.startsWith("antnest-") ? name : `antnest-${name}`;
const scope = (name) => `scope=${packageName(name)}`;
const platforms = ["linux/amd64"];

// The primary image a variant shares layers with: the images its contexts
// build, or the image whose Dockerfile it builds another stage of.
function sharedImages(name) {
  const spec = imageSpec(name);
  if (spec.contexts)
    return Object.values(spec.contexts).map(({ image }) => image);
  if (!isVariant(name)) return [];
  return Object.keys(images).filter(
    (other) => images[other] === spec.dockerfile,
  );
}

// Unchanged layers come from the cache the image workflows publish on main.
// Variants have no image workflow, so they also write their own scope.
export function bakeDefinition(names, context = ".") {
  const target = {};
  const base = (image, stage) => {
    const id = ["base", image, stage].filter(Boolean).join("-");
    target[id] = {
      context,
      dockerfile: imageSpec(image).dockerfile,
      platforms,
      ...(stage && { target: stage }),
      "cache-from": [`type=gha,${scope(image)}`],
    };
    return `target:${id}`;
  };
  for (const name of names) {
    const spec = imageSpec(name);
    const contexts =
      spec.contexts &&
      Object.fromEntries(
        Object.entries(spec.contexts).map(([ref, { image, target: stage }]) => [
          ref,
          base(image, stage),
        ]),
      );
    target[name] = {
      context,
      dockerfile: spec.dockerfile,
      platforms,
      tags: [`antnest/${name}:local`],
      ...(spec.target && { target: spec.target }),
      ...(spec.args && { args: spec.args }),
      ...(contexts && { contexts }),
      "cache-from": [...new Set([name, ...sharedImages(name)])].map(
        (image) => `type=gha,${scope(image)}`,
      ),
      ...(isVariant(name) && {
        "cache-to": [`type=gha,mode=max,${scope(name)}`],
      }),
    };
  }
  return { group: { default: { targets: names } }, target };
}

// The context paths a Dockerfile copies; `--from` copies read build stages.
// An empty string stands for the whole context.
export function dockerfileSources(text) {
  const sources = [];
  for (const line of text.replace(/\\\r?\n/gu, " ").split(/\r?\n/u)) {
    const [instruction = "", ...args] = line.trim().split(/\s+/u);
    if (!/^(?:COPY|ADD)$/iu.test(instruction)) continue;
    if (args.some((arg) => arg.startsWith("--from="))) continue;
    const paths = args.filter((arg) => !arg.startsWith("--")).slice(0, -1);
    for (const path of paths)
      sources.push(
        path === "." ? "" : path.replace(/^\.\//u, "").replace(/\/+$/u, ""),
      );
  }
  return sources;
}

function copies(source, file) {
  if (source === "") return true;
  if (/[*?[]/u.test(source))
    return matchesGlob(file, source) || matchesGlob(file, `${source}/**`);
  return file === source || file.startsWith(`${source}/`);
}

export function listTree(head = "HEAD", git = execFileSync) {
  const output = git("git", ["ls-tree", "-r", "-z", "--full-tree", head], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const tree = new Map();
  for (const entry of output.split("\0").filter(Boolean)) {
    const [meta, path] = entry.split("\t");
    const [mode, , object] = meta.split(" ");
    tree.set(path, { mode, object });
  }
  return tree;
}

// Hashes the tracked files a build can read, so an image is rebuilt exactly
// when its Dockerfile, .dockerignore or a copied source changes. Untracked
// files never reach CI checkouts. A variant also covers the images its
// contexts build and its own build options.
function buildInputs(dockerfile, tree, readBlob) {
  const entry = tree.get(dockerfile);
  if (!entry) throw new Error(`${dockerfile} is not tracked`);
  const sources = [
    dockerfile,
    ".dockerignore",
    ...dockerfileSources(readBlob(entry.object)),
  ];
  const files = [...tree.keys()].filter((file) =>
    sources.some((source) => copies(source, file)),
  );
  for (const source of sources)
    if (!files.some((file) => copies(source, file)))
      throw new Error(`${dockerfile} copies ${source}, which is not tracked`);
  return files;
}

export function imageDigest(name, tree, readBlob) {
  const spec = imageSpec(name);
  const files = new Set(buildInputs(spec.dockerfile, tree, readBlob));
  for (const { image } of Object.values(spec.contexts ?? {}))
    for (const file of buildInputs(imageSpec(image).dockerfile, tree, readBlob))
      files.add(file);
  const hash = createHash("sha256").update(`${name}\n`);
  if (isVariant(name)) hash.update(`${JSON.stringify(spec)}\n`);
  for (const file of [...files].sort()) {
    const { mode, object } = tree.get(file);
    hash.update(`${mode} ${object}\t${file}\n`);
  }
  return hash.digest("hex").slice(0, 32);
}

export function imageReference(name, digest) {
  return `${registry}/${packageName(name)}:inputs-${digest}`;
}

export function imageExists(ref, run = execFileSync) {
  try {
    run("docker", ["manifest", "inspect", ref], {
      stdio: "ignore",
      timeout: 60_000,
    });
    return true;
  } catch {
    return false;
  }
}

export function resolveImages(names, { tree, readBlob, exists }) {
  return names.map((name) => {
    const ref = imageReference(name, imageDigest(name, tree, readBlob));
    return {
      name,
      dockerfile: imageSpec(name).dockerfile,
      ref,
      build: !exists(ref),
    };
  });
}

export function suiteImages(selected) {
  return [...new Set(selected.flatMap((suite) => suite.images ?? []))].sort();
}

function relevant(file) {
  return (
    !ignored.some((glob) => matchesGlob(file, glob)) ||
    parsedProse.some((glob) => matchesGlob(file, glob))
  );
}

export function selectSuites(files, { all = false, only } = {}) {
  if (only) {
    for (const id of only)
      if (!suites.some((suite) => suite.id === id))
        throw new Error(`unknown suite ${id}`);
    return suites.filter((suite) => !suite.disabled && only.includes(suite.id));
  }
  const changed = files.filter(relevant);
  const global = changed.some((file) =>
    everySuite.some((glob) => matchesGlob(file, glob)),
  );
  return suites.filter(
    (suite) =>
      !suite.disabled &&
      (all ||
        global ||
        changed.some((file) =>
          suite.paths.some((glob) => matchesGlob(file, glob)),
        )),
  );
}

// GitHub matrices accept only scalar conditions, so setup becomes flags.
export function matrixEntry(suite) {
  const entry = {
    id: suite.id,
    name: suite.name,
    tier: suite.tier.toUpperCase(),
    run: suite.run.join("\n"),
    images: (suite.images ?? []).join(","),
    pull: (suite.pull ?? []).join(" "),
    strict_exit: suite.strict === true,
  };
  for (const setup of setups)
    entry[`setup_${setup.replaceAll("-", "_")}`] = suite.setup.includes(setup);
  return entry;
}

// A shard is one CI job: its selected suites run in order on one runner
// (tests/support/ci-shard.mjs), so jobs follow product areas rather than
// individual targets. Destructive suites come last in their shard.
export const shards = [
  {
    id: "a-postgres",
    name: "PostgreSQL components",
    suites: [
      "egress-postgres",
      "runtime-controller-postgres",
      "identity-postgres",
      "agent-controller-postgres",
      "agent-acp-postgres",
    ],
  },
  {
    id: "a-browser",
    name: "Browser components",
    suites: ["admin-console-browser", "agent-ui-browser"],
  },
  {
    id: "a-contracts",
    name: "Deployment contracts and SDK probes",
    suites: ["deployment-contracts", "elicitation-sdk-probe"],
  },
  {
    id: "b-auth",
    name: "Service authentication",
    suites: [
      "auth-console",
      "auth-controller",
      "auth-egress",
      "auth-gateway",
      "auth-identity",
      "auth-runtime-controller",
      "auth-runtime",
    ],
  },
  {
    id: "b-deployment",
    name: "Deployment",
    suites: ["deployment-docker", "deployment-transports", "deployment-wiring"],
  },
  {
    id: "b-runtime",
    name: "Runtime plane",
    suites: ["observation-retry", "shell-stage1", "shell-runtime-controller"],
  },
  {
    id: "b-gateway",
    name: "Edge Gateway and Agent UI",
    suites: ["gateway-security-headers", "agent-ui-receipt"],
  },
  {
    id: "b-skills",
    name: "Skill Registry and Runtime Skills",
    suites: [
      "skill-registry-discovery",
      "skill-registry-rc-prepare",
      "skill-registry-console",
      "skill-temporary-runtime",
      "skill-learning-runtime",
    ],
  },
  {
    id: "b-managed-mcp",
    name: "Managed MCP secrets",
    suites: ["managed-mcp-secrets-v1", "managed-mcp-secrets-v2"],
  },
  {
    id: "c-acp",
    name: "ACP workspace",
    suites: [
      "c-stage3-local",
      "c-file-observations",
      "c-multimodal",
      "c-session-cost",
      "c-slash-commands",
      "c-structured-plan",
      "c-acp-closeout",
    ],
  },
  {
    id: "c-acp-tools",
    name: "ACP tool permissions and progress",
    suites: ["c-tool-permissions", "c-tool-progress"],
  },
  {
    id: "c-identity",
    name: "Identity and access",
    suites: [
      "c-identity-core",
      "c-organization-display",
      "c-agent-access",
      "c-acp-session",
      "c-identity-access",
    ],
  },
  {
    id: "c-acp-recovery",
    name: "ACP restart and response loss",
    suites: ["c-acp-restart", "c-rpc-response-loss"],
  },
  {
    id: "c-skill-delivery",
    name: "Skill delivery",
    suites: [
      "c-stage3-skill-delivery",
      "c-stage4-skill-registry-outage",
      "c-stage4-skill-offline-reuse",
      "c-stage4-skill-restart-rebuild",
    ],
  },
  {
    id: "c-skill-discovery",
    name: "Skill discovery and deployment",
    suites: [
      "c-service-authentication-integration",
      "c-skill-source-lifecycle",
      "c-skill-discovery-caller",
    ],
  },
  {
    id: "c-skill-learning",
    name: "Skill learning",
    suites: [
      "c-runtime-tool-usability",
      "c-skill-learning-cleanup",
      "c-skill-learning-browser",
      "c-skill-learning-key-rotation",
      "c-skill-learning-key-compromise",
    ],
  },
  {
    id: "c-skill-install",
    name: "Skill learning install and lifecycle",
    suites: [
      "c-skill-learning-install-held-disable",
      "c-skill-learning-install-held-foreground",
      "c-skill-learning-install-pre-dispatch-disable",
      "c-skill-learning-install-after-rename-disable",
      "c-skill-learning-install-after-rename-foreground",
      "c-skill-learning-install-lost",
      "c-skill-learning-lifecycle-rebuild",
      "c-skill-learning-restart",
    ],
  },
  {
    id: "c-lifecycle",
    name: "Agent lifecycle",
    suites: ["c-stage2", "c-lifecycle", "c-lifecycle-loss"],
  },
  {
    id: "c-operations",
    name: "Backup, restore and shutdown",
    suites: [
      "c-lifecycle-restore",
      "c-stage4-skill-restore",
      "c-stage4-skill-storage-restore",
      "c-lifecycle-shutdown",
    ],
  },
  {
    id: "c-workspace",
    name: "Workspace closeout",
    suites: ["c-workspace", "c-workspace-browser"],
  },
];

const union = (lists) => [...new Set(lists.flat())].sort();

export function shardEntry(shard, members) {
  const entries = members.map(matrixEntry);
  const entry = {
    id: shard.id,
    name: shard.name,
    tier: entries[0].tier,
    images: union(members.map((suite) => suite.images ?? [])).join(","),
    pull: union(members.map((suite) => suite.pull ?? [])).join(" "),
    // A JSON string keeps every matrix value scalar.
    suites: JSON.stringify(
      entries.map(({ id, name, run, strict_exit }) => ({
        id,
        name,
        run,
        strict: strict_exit,
      })),
    ),
  };
  for (const setup of setups) {
    const flag = `setup_${setup.replaceAll("-", "_")}`;
    entry[flag] = entries.some((row) => row[flag]);
  }
  return entry;
}

export function matrix(selected) {
  const chosen = new Map(selected.map((suite) => [suite.id, suite]));
  return {
    include: shards.flatMap((shard) => {
      const members = shard.suites
        .filter((id) => chosen.has(id))
        .map((id) => chosen.get(id));
      return members.length ? [shardEntry(shard, members)] : [];
    }),
  };
}

export function matrices(selected) {
  const { include } = matrix(selected);
  const required = include.filter((row) => row.tier !== "C");
  return {
    plain: { include: required.filter((row) => row.images === "") },
    imaged: { include: required.filter((row) => row.images !== "") },
    optional: { include: include.filter((row) => row.tier === "C") },
  };
}

const zeroSha = /^0+$/u;

export function changedFiles(base, head, git = execFileSync) {
  const output = git(
    "git",
    ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return output.split("\0").filter(Boolean);
}

function main() {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      head: { type: "string", default: "HEAD" },
      all: { type: "boolean", default: false },
      bake: { type: "string" },
      "resolve-images": { type: "boolean", default: false },
      "all-images": { type: "boolean", default: false },
      only: { type: "string" },
    },
  });
  if (values.bake !== undefined) {
    const names = values.bake.split(",").filter(Boolean);
    console.log(JSON.stringify(bakeDefinition(names, process.cwd()), null, 2));
    return;
  }
  const all = values.all || !values.base || zeroSha.test(values.base);
  const files = all ? [] : changedFiles(values.base, values.head);
  const only = values.only?.split(/[\s,]+/u).filter(Boolean);
  const selected = selectSuites(files, {
    all,
    only: only?.length ? only : undefined,
  });
  const { plain, imaged, optional } = matrices(selected);
  const lines = [
    `suites=${JSON.stringify(plain)}`,
    `plain=${plain.include.length}`,
    `image_suites=${JSON.stringify(imaged)}`,
    `imaged=${imaged.include.length}`,
    `optional_suites=${JSON.stringify(optional)}`,
    `optional=${optional.include.length}`,
  ];
  let resolved = [];
  if (values["resolve-images"]) {
    const tree = listTree(values.head);
    const readBlob = (object) =>
      execFileSync("git", ["cat-file", "blob", object], { encoding: "utf8" });
    resolved = resolveImages(
      values["all-images"] ? Object.keys(images).sort() : suiteImages(selected),
      { tree, readBlob, exists: imageExists },
    );
    const builds = resolved.filter((image) => image.build);
    lines.push(
      `images=${JSON.stringify(Object.fromEntries(resolved.map(({ name, ref, build }) => [name, { ref, build }])))}`,
      `builds=${JSON.stringify({ include: builds.map(({ name, ref }) => ({ name, ref })) })}`,
      `building=${builds.length}`,
    );
  }
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  const summary = [
    only?.length
      ? `${selected.length} named suite(s) selected.`
      : all
        ? "All suites selected."
        : `${files.length} changed file(s); ${selected.length} of ${suites.length} suites selected.`,
    "",
    ...suites.map(
      (suite) =>
        `- ${suite.disabled ? "disabled" : selected.includes(suite) ? "run" : "skip"}: ${suite.name} (tier ${suite.tier.toUpperCase()})${suite.disabled ? `: ${suite.disabled}` : ""}`,
    ),
    ...(resolved.length > 0 ? ["", "Images:", ""] : []),
    ...resolved.map(
      (image) =>
        `- ${image.build ? "build" : "pull"}: ${image.name} (${image.ref})`,
    ),
  ].join("\n");
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  console.log(summary);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
