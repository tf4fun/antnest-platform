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

const registry = "ghcr.io/tf4fun";
const packageName = (name) =>
  name.startsWith("antnest-") ? name : `antnest-${name}`;

// Unchanged layers come from the cache the image workflows publish on main.
export function bakeDefinition(names, context = ".") {
  const target = {};
  for (const name of names) {
    if (!Object.hasOwn(images, name)) throw new Error(`unknown image ${name}`);
    target[name] = {
      context,
      dockerfile: images[name],
      platforms: ["linux/amd64"],
      tags: [`antnest/${name}:local`],
      "cache-from": [`type=gha,scope=${packageName(name)}`],
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
// files never reach CI checkouts.
export function imageDigest(name, tree, readBlob) {
  const dockerfile = images[name];
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
  const hash = createHash("sha256").update(`${name}\n`);
  for (const file of files.sort()) {
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
    return { name, dockerfile: images[name], ref, build: !exists(ref) };
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

export function matrices(selected) {
  const needsImages = (suite) => (suite.images ?? []).length > 0;
  return {
    plain: matrix(selected.filter((suite) => !needsImages(suite))),
    imaged: matrix(selected.filter(needsImages)),
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
  const { plain, imaged } = matrices(selected);
  const lines = [
    `suites=${JSON.stringify(plain)}`,
    `plain=${plain.include.length}`,
    `image_suites=${JSON.stringify(imaged)}`,
    `imaged=${imaged.include.length}`,
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
    all
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
