import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Import the real client helper in a fresh module graph. Contracts are visible
// only when its Docker arguments mount them, even though the checkout has them.
export function assertContainerContractImports(args, entry) {
  const root = new URL("../../", import.meta.url);
  const mounted = args
    .filter((arg) => arg.includes(":/app/contracts/"))
    .map((arg) => arg.slice(0, arg.indexOf(":/app/contracts/")));
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {createRequire, registerHooks} from "node:module";
    import {fileURLToPath, pathToFileURL} from "node:url";
    const [root, mounted, entry] = JSON.parse(process.argv[1]);
    const require = createRequire(new URL("services/agent-acp-service/package.json", root));
    const ajv = pathToFileURL(require.resolve("ajv/dist/2020.js")).href;
    registerHooks({resolve(specifier, context, next) {
      const resolved = specifier === "ajv/dist/2020.js"
        ? {url: ajv, shortCircuit: true}
        : next(specifier, context);
      if (resolved.url.startsWith(new URL("contracts/", root).href) &&
          !mounted.includes(fileURLToPath(resolved.url)))
        throw new Error("Container contract is not mounted: " + resolved.url);
      return resolved;
    }});
    await import(new URL(entry, root));
  `,
      JSON.stringify([root.href, mounted, entry]),
    ],
    {
      cwd: fileURLToPath(root),
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
}
