import { readFileSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeGoOverlay } from "./go-overlay.mjs";
import { runCommand } from "./run-command.mjs";

export async function withGoTestSources({ root, services, output }, run) {
  // golangci's package parser reads physical files rather than Go CLI overlays.
  // Use the same mapping temporarily; the root files remain the only sources.
  const mappings = services.map(
    (service) =>
      JSON.parse(
        readFileSync(
          writeGoOverlay({ root, service, output, profile: "all" }),
          "utf8",
        ),
      ).Replace,
  );
  const created = [];
  let primaryError;
  try {
    for (const mapping of mappings) {
      for (const [original, source] of Object.entries(mapping)) {
        symlinkSync(source, original);
        created.push([original, source]);
      }
    }
    return await run();
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    for (const [original, source] of created.reverse()) {
      try {
        if (readlinkSync(original) === source) unlinkSync(original);
      } catch (error) {
        // Preserve files that another writer replaced while lint was running.
        if (!["ENOENT", "EINVAL"].includes(error.code))
          cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        [...(primaryError ? [primaryError] : []), ...cleanupErrors],
        "Go lint temporary source cleanup failed",
      );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const overlayServices = [
    "runtime-controller",
    "identity-service",
    "agent-controller",
    "admin-console",
    "edge-gateway",
    "skill-registry",
  ];
  const requested = process.argv.slice(2);
  for (const service of requested) {
    if (!overlayServices.includes(service))
      throw new Error(`unknown Go lint service: ${service}`);
  }
  const services = requested.length ? requested : overlayServices;
  const output = resolve(root, "artifacts/verification/go-lint");
  const result = await withGoTestSources({ root, services, output }, () =>
    runCommand({
      command: [
        "golangci-lint",
        "run",
        ...services.map((service) => `./services/${service}/...`),
        ...(requested.length ? [] : ["./modules/service-authentication/..."]),
      ],
      cwd: root,
      output,
      name: `go-lint-${Date.now()}-${process.pid}`,
    }),
  );
  console.log(JSON.stringify(result));
  process.exitCode = result.exit_code;
}
