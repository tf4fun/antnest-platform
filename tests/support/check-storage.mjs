import { lstatSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const rebuildableCaches = new Set([
  "go-build",
  "go-mod",
  "golangci-lint",
  "npm",
  "rust-build",
]);

export function cacheViolations(root) {
  const cache = resolve(root, ".cache");
  try {
    if (!lstatSync(cache).isDirectory()) return [".cache"];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const violations = [];
  const reject = (path) => violations.push(relative(root, path));
  const regular = (path) => {
    try {
      return lstatSync(path).isFile();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return false;
    }
  };
  function walk(directory, accepted) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path, accepted);
      else if (!entry.isFile() || !accepted(path)) reject(path);
    }
  }
  function goObjects(directory) {
    walk(directory, (path) => {
      const name = relative(directory, path);
      const match = /^([a-f0-9]{2})\/([a-f0-9]{64})-[ad]$/.exec(name);
      return (
        ["README", "trim.txt"].includes(name) ||
        (match && match[2].startsWith(match[1]))
      );
    });
  }
  function modules(directory, base = directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = relative(base, path);
      if (!entry.isDirectory()) {
        reject(path);
        continue;
      }
      if (name === "cache") {
        walk(path, (file) => {
          const name = relative(path, file);
          return (
            name === "lock" ||
            /^download\/.+\/@v\/(?:list|v[^/]+\.(?:info|mod|zip|ziphash|lock))$/.test(
              name,
            ) ||
            /^download\/sumdb\/[^/]+\/lookup\/.+@v[^/]+$/.test(name) ||
            /^download\/sumdb\/[^/]+\/tile\/[0-9]+\/[0-9]+\/(?:x[0-9]+\/)*[0-9]+(?:\.p\/[0-9]+)?$/.test(
              name,
            )
          );
        });
      } else if (entry.name.includes("@")) {
        const match = /^(.*)@(v[^/]+)$/.exec(name);
        // A downloaded module may include upstream tests and generated files.
        // Bind that exemption to its Go download checksum record.
        if (
          !match ||
          !regular(
            join(base, "cache/download", match[1], "@v", match[2] + ".ziphash"),
          )
        )
          reject(path);
        else walk(path, () => true);
      } else modules(path, base);
    }
  }
  function npmCache(directory) {
    walk(directory, (path) => {
      const name = relative(directory, path);
      return (
        name === "_update-notifier-last-checked" ||
        name === "_cacache/_lastverified" ||
        /^_logs\/[0-9T_Z.-]+-debug-[0-9]+\.log$/.test(name) ||
        /^_cacache\/content-v2\/sha512\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{124}$/.test(
          name,
        ) ||
        /^_cacache\/index-v5\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{60}$/.test(
          name,
        ) ||
        /^_cacache\/tmp\/(?:[a-f0-9]+|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(
          name,
        )
      );
    });
  }
  function cargoCache(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      if (
        !entry.isDirectory() ||
        !regular(join(target, "CACHEDIR.TAG")) ||
        !regular(join(target, ".rustc_info.json"))
      ) {
        reject(target);
        continue;
      }
      walk(target, (path) => {
        const name = relative(target, path);
        return (
          ["CACHEDIR.TAG", ".rustc_info.json"].includes(name) ||
          /^(?:debug|release)\/\.cargo-(?:build-|artifact-)?lock$/.test(name) ||
          /^(?:debug|release)\/\.fingerprint\/[a-zA-Z0-9_-]+-[a-f0-9]{16}\/(?:invoked\.timestamp|(?:dep-|run-)?(?:lib|bin|test-integration-test|test-lib|example|build-script-build)-[a-zA-Z0-9_-]+(?:\.json)?)$/.test(
            name,
          ) ||
          /^(?:debug|release)\/build\/[a-zA-Z0-9_-]+-[a-f0-9]{16}\/(?:out\/.+|stderr|output|root-output|invoked\.timestamp|build-script-build|build_script_build-[a-f0-9]{16}(?:\.d)?)$/.test(
            name,
          ) ||
          /^(?:debug|release)\/incremental\/[a-zA-Z0-9_-]+-[a-z0-9]+\/(?:[a-z0-9_-]+\.lock|[a-z0-9_-]+\/[a-z0-9_-]+\.(?:o|bin|rmeta))$/.test(
            name,
          ) ||
          /^(?:debug|release)\/(?:deps|examples)\/(?:lib)?[a-zA-Z0-9_-]+-[a-f0-9]{16}(?:\.(?:d|rlib|rmeta|so|dylib|dll|exe|o))?$/.test(
            name,
          ) ||
          /^(?:debug|release)\/deps\/[a-zA-Z0-9_-]+-[a-f0-9]{16}\.[a-zA-Z0-9_.-]+\.rcgu\.o$/.test(
            name,
          ) ||
          (/^(?:debug|release)\/examples\/[a-zA-Z0-9_-]+(?:\.d)?$/.test(name) &&
            regular(path.endsWith(".d") ? path.slice(0, -2) : path + ".d"))
        );
      });
    }
  }
  const caches = {
    "go-build": goObjects,
    "golangci-lint": goObjects,
    "go-mod": modules,
    npm: npmCache,
    "rust-build": cargoCache,
  };
  function inspect(directory, top = false) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (top && rebuildableCaches.has(entry.name) && entry.isDirectory()) {
        caches[entry.name](path);
        continue;
      }
      if (entry.isDirectory()) inspect(path);
      else violations.push(relative(root, path));
    }
  }
  inspect(cache, true);
  return violations.sort();
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const violations = cacheViolations(root);
  console.log(
    JSON.stringify({
      status: violations.length ? "failed" : "passed",
      cache_violations: violations,
    }),
  );
  process.exitCode = violations.length ? 1 : 0;
}
