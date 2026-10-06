// Selects the integration suites a change set must run. The integration
// workflow always runs; its suite job consumes the matrix printed here.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// Any change here can alter every suite's environment or selection.
const everySuite = [
  ".github/workflows/integration.yml",
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
    disabled:
      "the workspace bridge test can release a held view before the request arrives (#121)",
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
    images: ["antnest-runtime", "agent-acp-service", "runtime-egress"],
    pull: base,
    disabled:
      "its Compose override still joins the `development` network that #32 removed",
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
    disabled:
      mode === "stage1"
        ? "Workspace cleanup fails on Linux and the image build exceeds its timeout (#122)"
        : undefined,
    paths: [
      ...service(...owners),
      ...runtime,
      "tests/e2e/e2e-stage1.sh",
      "tests/e2e/runtime-controller/**",
      ...go,
      ...compose,
    ],
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
      "it reaches ACP through a service name that can resolve to a non-listening address (#120)",
    ],
  ].map(([id, name, setup, run, disabled]) => ({
    id,
    name,
    tier: "b",
    setup,
    disabled,
    images: [
      "antnest-runtime",
      "temporal",
      "runtime-egress",
      "agent-controller",
      "skill-registry",
      "admin-console",
    ],
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
    pull: base,
    paths: [
      ...service("skill-registry"),
      "tests/e2e/skill-registry/**",
      "tests/e2e/service-authentication/registry/**",
      ...go,
      ...compose,
    ],
    run: ["make e2e-skill-discovery-registry"],
  },
  {
    id: "skill-registry-console",
    name: "Skill Registry Admin Console discovery",
    tier: "b",
    setup: ["admin-web", "chromium"],
    pull: base,
    disabled: "the runner predates unified service authentication (#119)",
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
    pull: base,
    disabled:
      "the Runtime container exits before publishing its port, also outside CI",
    paths: [
      ...runtime,
      "tests/e2e/skill-registry/**",
      "tests/e2e/antnest-runtime/**",
    ],
    run: ["make e2e-skill-temporary-runtime"],
  },
  {
    id: "skill-learning-runtime",
    name: "Skill learning runtime preparation",
    tier: "b",
    setup: [],
    pull: base,
    disabled:
      "the Runtime container exits before publishing its port, as in the temporary runtime suite",
    paths: [...runtime, "tests/e2e/skill-learning/**"],
    run: ["make e2e-skill-learning-runtime"],
  },
];

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
};

// Unchanged layers come from the cache the image workflows publish on main.
export function bakeDefinition(names, context = ".") {
  const target = {};
  for (const name of names) {
    if (!Object.hasOwn(images, name)) throw new Error(`unknown image ${name}`);
    const scope = name.startsWith("antnest-") ? name : `antnest-${name}`;
    target[name] = {
      context,
      dockerfile: images[name],
      platforms: ["linux/amd64"],
      tags: [`antnest/${name}:local`],
      "cache-from": [`type=gha,scope=${scope}`],
    };
  }
  return { group: { default: { targets: names } }, target };
}

function relevant(file) {
  return (
    !ignored.some((glob) => matchesGlob(file, glob)) ||
    parsedProse.some((glob) => matchesGlob(file, glob))
  );
}

export function selectSuites(files, { all = false } = {}) {
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
  };
  for (const setup of setups)
    entry[`setup_${setup.replaceAll("-", "_")}`] = suite.setup.includes(setup);
  return entry;
}

export function matrix(selected) {
  return { include: selected.map(matrixEntry) };
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
    },
  });
  if (values.bake !== undefined) {
    const names = values.bake.split(",").filter(Boolean);
    console.log(JSON.stringify(bakeDefinition(names, process.cwd()), null, 2));
    return;
  }
  const all = values.all || !values.base || zeroSha.test(values.base);
  const files = all ? [] : changedFiles(values.base, values.head);
  const selected = selectSuites(files, { all });
  const lines = [
    `suites=${JSON.stringify(matrix(selected))}`,
    `selected=${selected.length}`,
  ];
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  const summary = [
    all
      ? "All suites selected."
      : `${files.length} changed file(s); ${selected.length} of ${suites.length} suites selected.`,
    "",
    ...suites.map(
      (suite) =>
        `- ${suite.disabled ? "disabled" : selected.includes(suite) ? "run" : "skip"}: ${suite.name} (tier ${suite.tier.toUpperCase()})${suite.disabled ? `: ${suite.disabled}` : ""}`,
    ),
  ].join("\n");
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  console.log(summary);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
