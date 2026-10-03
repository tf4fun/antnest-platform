import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(
  new URL("../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = require("ajv/dist/2020.js");
export const serviceContracts = {
  "identity-service": "contracts/identity",
  "edge-gateway": "contracts/edge-gateway",
  "admin-console": "contracts/admin-console",
  "agent-ui": "contracts/agent-ui",
  "agent-controller": "contracts/agent-controller",
  "agent-acp-service": "contracts/agent-acp",
  "runtime-controller": "services/runtime-controller/api",
  "skill-registry": "contracts/skill-registry",
  "runtime-egress": "contracts/egress",
  "antnest-runtime": "contracts/runtime",
};

function files(directory) {
  if (!existsSync(join(root, directory))) return [];
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(
    (entry) => {
      if (
        ["node_modules", "target", "dist", "static", "test", "tests"].includes(
          entry.name,
        )
      )
        return [];
      const path = `${directory}/${entry.name}`;
      return entry.isDirectory() ? files(path) : [path];
    },
  );
}

export function collectSources(transform = (_path, source) => source) {
  const sources = {};
  for (const service of Object.keys(serviceContracts)) {
    const directory =
      service === "antnest-runtime"
        ? "runtimes/antnest-runtime/src"
        : service === "agent-ui"
          ? "services/agent-ui/web/server/src"
          : `services/${service}`;
    for (const path of files(directory)) {
      if (
        !/\.(?:go|ts|rs)$/u.test(path) ||
        /(?:_test\.go|\.test\.ts)$/u.test(path)
      )
        continue;
      sources[path] = {
        service,
        source: transform(path, readFileSync(join(root, path), "utf8")),
      };
    }
  }
  return sources;
}

// Go is parsed with its standard AST, including table/loop registrations. TS
// custom matchers and Rust routers use explicit reviewed catalogs plus source
// guards until their service batches provide declarative route registration.
export function discoverRoutes(sources) {
  const go = Object.fromEntries(
    Object.entries(sources)
      .filter(
        ([path, { source }]) =>
          path.endsWith(".go") && /\.Handle(?:Func)?\s*\(/u.test(source),
      )
      .map(([path, { source }]) => [path, source]),
  );
  // go run caches a named executable on newer Go releases. Build an explicit
  // temporary output instead, retaining only ordinary compiler objects.
  const work = mkdtempSync(join(tmpdir(), "antnest-route-inventory-"));
  const binary = join(work, "route-inventory");
  const options = {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...globalThis.process.env, GOWORK: "off" },
  };
  try {
    const build = spawnSync(
      "go",
      [
        "build",
        "-o",
        binary,
        "tests/support/service-authentication-go-routes.go",
      ],
      options,
    );
    if (build.status !== 0)
      throw new Error(
        `Go route scanner build failed (${build.error?.code ?? build.status})`,
      );
    const scan = spawnSync(binary, [], {
      ...options,
      input: JSON.stringify(go),
    });
    if (scan.status !== 0)
      throw new Error(
        `Go route discovery failed (${scan.error?.code ?? scan.status})`,
      );
    return JSON.parse(scan.stdout);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function needsSourceGuard(path, source) {
  if (path.endsWith(".ts") && /createServer\s*\(/u.test(source)) return true;
  if (path.endsWith(".ts"))
    return (
      /createServer\s*\(|\.pathname|request\.url|request\.method|rawUrl|rawPath|IncomingMessage|ServerResponse|parseWorkspaceDocumentPath|create.*Handler\(/u.test(
        source,
      ) &&
      /(?:\/http\/|\/transport\/|\/protocol\/workspace-route\.ts$|\/workspace-runtime\.ts$)/u.test(
        path,
      )
    );
  return (
    path.endsWith(".rs") &&
    /\.route\s*\(|\.nest_service\s*\(/u.test(source) &&
    /Router/u.test(source)
  );
}

export async function checkRepository({
  transformPolicy = (_service, policy) => policy,
  transformSource,
  additionalSources = {},
} = {}) {
  const errors = [];
  const schema = JSON.parse(
    readFileSync(
      join(root, "contracts/platform/service-callers.schema.json"),
      "utf8",
    ),
  );
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(
    schema,
  );
  const sources = { ...collectSources(transformSource), ...additionalSources };
  const discovered = discoverRoutes(sources);
  let routeCount = 0;
  const actualServices = readdirSync(join(root, "services"), {
    withFileTypes: true,
  })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(join(root, "services", entry.name, "Dockerfile")),
    )
    .map((entry) => entry.name);
  for (const service of actualServices)
    if (!(service in serviceContracts))
      errors.push(`${service}: missing service caller catalog`);

  for (const [service, directory] of Object.entries(serviceContracts)) {
    const file = `${directory}/callers.json`;
    if (!existsSync(join(root, file))) {
      errors.push(`${service}: missing ${file}`);
      continue;
    }
    const policy = transformPolicy(
      service,
      JSON.parse(readFileSync(join(root, file), "utf8")),
    );
    if (!validate(policy))
      for (const error of validate.errors)
        errors.push(
          `${service}${error.instancePath}: ${error.message} ${JSON.stringify(error.params)}`,
        );
    if (policy.service !== service)
      errors.push(`${service}: catalog service mismatch`);
    const registered = new Set();
    for (const [path, scan] of Object.entries(discovered)) {
      if (sources[path].service !== service) continue;
      errors.push(...scan.errors);
      for (const route of scan.routes) registered.add(route);
    }
    for (const [path, { service: owner, source }] of Object.entries(sources)) {
      if (owner !== service || !needsSourceGuard(path, source)) continue;
      const guard = policy.guarded_sources[path];
      if (
        !guard ||
        guard.sha256 !== createHash("sha256").update(source).digest("hex")
      )
        errors.push(`${service}: ${path} requires route catalog review`);
      if (guard) for (const route of guard.routes) registered.add(route);
    }
    for (const path of Object.keys(policy.guarded_sources)) {
      const entry = sources[path];
      if (
        !entry ||
        entry.service !== service ||
        !needsSourceGuard(path, entry.source)
      )
        errors.push(`${service}: stale source guard ${path}`);
    }
    for (const route of registered)
      if (!(route in policy.routes))
        errors.push(`${service}: missing caller policy for ${route}`);
    for (const [route, access] of Object.entries(policy.routes)) {
      routeCount++;
      if (!registered.has(route))
        errors.push(`${service}: stale caller policy for ${route}`);
      const callers = access.callers ?? [];
      if (callers.length === 0 && access.authentication !== "deny")
        errors.push(`${service}: ${route} needs nonempty callers`);
      if (callers.length !== 0 && access.authentication === "deny")
        errors.push(`${service}: ${route} deny policy has callers`);
      if (
        JSON.stringify([...callers].sort()) !==
        JSON.stringify(Object.keys(access.caller_context).sort())
      )
        errors.push(
          `${service}: ${route} caller context does not match callers`,
        );
      if (access.authentication === "public" && service !== "edge-gateway")
        errors.push(`${service}: ${route} cannot use public authentication`);
      if (access.authentication === "delegate" && !route.startsWith("* "))
        errors.push(
          `${service}: ${route} cannot delegate an exact business route`,
        );
      if (
        access.authentication === "health" &&
        (!/^GET \/(?:status|live|rpc\/agent-controller\/status)$/u.test(
          route,
        ) ||
          JSON.stringify(callers) !== '["local-healthcheck"]')
      )
        errors.push(`${service}: ${route} invalid health exception`);
      if (
        access.authentication === "workload" &&
        callers.some((caller) => !(caller in serviceContracts))
      )
        errors.push(`${service}: ${route} requires service callers`);
    }
  }
  return {
    services: Object.keys(serviceContracts).length,
    routes: routeCount,
    errors,
  };
}

if (
  globalThis.process.argv[1] &&
  import.meta.url === pathToFileURL(globalThis.process.argv[1]).href
) {
  try {
    const result = await checkRepository();
    for (const error of result.errors) console.error(error);
    console.log(
      `checked ${result.services} service catalogs and ${result.routes} route caller policies (planned enforcement)`,
    );
    globalThis.process.exitCode = result.errors.length ? 1 : 0;
  } catch (error) {
    console.error(error.message);
    globalThis.process.exitCode = 1;
  }
}
