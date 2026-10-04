import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const shared =
  "github.com/tf4fun/antnest-platform/modules/service-authentication";
const directory = "modules/service-authentication";
const consumers = {
  "identity-service": null,
  "edge-gateway": "GatewayHeaders",
  "admin-console": "CallerContextHeaders",
  "agent-controller": "CallerContextHeaders",
  "runtime-controller": "CallerContextHeaders",
  "skill-registry": "WorkloadOnlyHeaders",
};

function goSources(base) {
  return readdirSync(join(root, base), { withFileTypes: true }).flatMap(
    (entry) => {
      if (
        ["node_modules", "dist", "static", "target", ".cache"].includes(
          entry.name,
        )
      )
        return [];
      const path = `${base}/${entry.name}`;
      return entry.isDirectory()
        ? goSources(path)
        : entry.isFile() && path.endsWith(".go")
          ? [path]
          : [];
    },
  );
}

// This checks ownership/build admission, not token or signature algorithms.
// Those use actual HTTP/TLS and shared-vector tests in the owning Go module.
export function checkGoAuthenticationModule({
  transform = (_path, source) => source,
  additionalSources = {},
} = {}) {
  const errors = [];
  const read = (path) =>
    transform(
      path,
      existsSync(join(root, path))
        ? readFileSync(join(root, path), "utf8")
        : "",
    );
  const sources = Object.fromEntries(
    [...goSources(directory), ...goSources("services")].map((path) => [
      path,
      read(path),
    ]),
  );
  Object.assign(sources, additionalSources);
  for (const [path, source] of Object.entries(sources)) {
    if (path.startsWith(`${directory}/`)) {
      if (source.includes('"github.com/tf4fun/antnest-platform/services/'))
        errors.push(`${path}: shared module imports a service implementation`);
      continue;
    }
    const packageName = /^\s*package\s+(\w+)/mu.exec(source)?.[1];
    if (packageName === "serviceauth")
      errors.push(
        `${path}: private serviceauth implementation must use the shared module`,
      );
    if (packageName === "callercontext") {
      if (!path.startsWith("services/identity-service/internal/callercontext/"))
        errors.push(
          `${path}: private callercontext implementation must use the shared module`,
        );
      else if (
        /\bfunc\s+(?:Verify|ParseKeys|NewVerifier|validKID|validID|validClaims)\s*\(/u.test(
          source,
        )
      )
        errors.push(`${path}: copied CCT verifier must use the shared module`);
    }
    const service = path.split("/")[1];
    if (consumers[service]) {
      const expected = new RegExp(
        `^"${service}"\\s*,\\s*serviceauth\\.${consumers[service]}\\s*,`,
        "u",
      );
      for (const call of source.matchAll(
        /\bserviceauth\.LoadOutbound\(\s*([^)]*)/gu,
      )) {
        if (!expected.test(call[1]))
          errors.push(
            `${path}: outbound authority policy must identify its owning caller and profile`,
          );
      }
    }
  }
  for (const service of Object.keys(consumers)) {
    const base = `services/${service}`;
    const mod = read(`${base}/go.mod`);
    const direct = mod
      .split("\n")
      .some(
        (line) =>
          line.trim() === `${shared} v0.0.0` ||
          line.trim() === `require ${shared} v0.0.0`,
      );
    if (!direct)
      errors.push(`${base}: missing direct shared module dependency`);
    if (!mod.includes(`replace ${shared} => ../../${directory}`))
      errors.push(`${base}: missing standalone shared module replace`);
    const docker = read(`${base}/Dockerfile`);
    const copy = docker.indexOf(`COPY ${directory} `);
    if (copy < 0 || copy > docker.indexOf("go mod download"))
      errors.push(
        `${base}: missing Docker shared module input before dependency download`,
      );
    if (
      !docker.includes(`WORKDIR /src/services/${service}`) &&
      !(
        docker.includes(`COPY ${base} ./services/${service}`) &&
        docker.includes(`cd services/${service}`)
      )
    )
      errors.push(
        `${base}: Docker repository layout must preserve the module replace`,
      );
    const workflow = read(`.github/workflows/${service}.yml`);
    if (
      (
        workflow.match(/^\s*- modules\/service-authentication\/\*\*\s*$/gmu) ??
        []
      ).length !== 2
    )
      errors.push(
        `${service}: missing shared module consumer CI coverage for push/pull_request`,
      );
  }
  if (!read("go.work").includes(`./${directory}`))
    errors.push("shared authentication: missing workspace member");
  const ci = read(".github/workflows/shared-go-authentication.yml");
  if (
    !ci.includes(`working-directory: ${directory}`) ||
    !ci.includes('GOWORK: "off"') ||
    !ci.includes("go vet ./...") ||
    !ci.includes("go test -race -count=1 ./...") ||
    !ci.includes("golangci-lint")
  )
    errors.push(
      "shared authentication: missing standalone shared module CI gates",
    );
  return errors.sort();
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const errors = checkGoAuthenticationModule();
  console.log(
    JSON.stringify({
      complete: errors.length === 0,
      consumers: Object.keys(consumers).length,
      errors,
    }),
  );
  process.exitCode = errors.length ? 1 : 0;
}
