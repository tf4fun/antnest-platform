import { execFileSync } from "node:child_process";
import { appendFileSync, lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

const root = fileURLToPath(new URL("../../", import.meta.url));
let cachedCatalog;

// Identity comes from tracked public source, never from an exception or a
// parameterized test's runtime inputs. Ambiguous identities are withheld.
export function sourceCatalog() {
  if (cachedCatalog) return cachedCatalog;
  const files = execFileSync(
    "git",
    ["ls-files", "-z", "--", "services", "modules", "tests"],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  ).split("\0");
  cachedCatalog = [];
  for (const file of files) {
    if (!/(?:_test\.go|\.test\.[cm]?[jt]sx?)$/u.test(file)) continue;
    const path = resolve(root, file);
    if (!lstatSync(path).isFile()) continue;
    const source = readFileSync(path, "utf8");
    const pattern = file.endsWith(".go")
      ? /^func\s+(Test\w+)\s*\(/gmu
      : /\b(?:test|it)(?:\.(?:only|skip|concurrent))?\(\s*(["'])([^\n]*?)\1/gu;
    for (const match of source.matchAll(pattern)) {
      const name = match[file.endsWith(".go") ? 1 : 2];
      if (/[\\\x00-\x1f]/u.test(name)) continue;
      cachedCatalog.push({
        name,
        file,
        line: source.slice(0, match.index).split("\n").length,
      });
    }
    cachedCatalog.push({ name: null, file, line: 1 });
  }
  return cachedCatalog;
}

export const markdownCell = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "&#124;")
    .replaceAll("`", "&#96;")
    .replace(/[\r\n]/gu, " ");

export function failureMarkdown(row) {
  return `| ${markdownCell(row.name)} | ${markdownCell(row.file)}:${row.line} | ${row.category} | failed | not yet reported |`;
}

export function emitFailure(row) {
  process.stdout.write(`${JSON.stringify({ ci_failure: row })}\n`);
}

export function publishFailure(row) {
  emitFailure(row);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `\n### Component failure (observed live)\n\n| Test | Source | Category | Business | Cleanup |\n| --- | --- | --- | --- | --- |\n${failureMarkdown(row)}\n`,
    );
}

export class FailureObserver {
  constructor({
    catalog = sourceCatalog,
    report = emitFailure,
    now = Date.now,
  } = {}) {
    this.catalog = catalog;
    this.report = report;
    this.now = now;
    this.streams = new Map();
    this.seen = new Set();
    this.failures = [];
  }

  write(chunk, channel = "stdout") {
    let state = this.streams.get(channel);
    if (!state) {
      state = { decoder: new StringDecoder("utf8"), text: "", dropping: false };
      this.streams.set(channel, state);
    }
    const text = state.decoder.write(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
    );
    for (const part of text.split(/(?<=\n)/u)) {
      if (!state.dropping) state.text += part;
      if (state.text.length > 65536) {
        state.text = "";
        state.dropping = true;
      }
      if (part.endsWith("\n")) {
        if (!state.dropping) this.accept(state.text.trim());
        state.text = "";
        state.dropping = false;
      }
    }
  }

  end() {
    for (const state of this.streams.values()) {
      if (!state.dropping)
        this.accept((state.text + state.decoder.end()).trim());
    }
    this.streams.clear();
  }

  accept(raw) {
    const line = raw.replace(/\u001b\[[0-9;]*m/gu, "").trim();
    let matches = [];
    try {
      if (line.startsWith("{")) {
        const event = JSON.parse(line);
        if (event.ci_failure) {
          matches = reportedFailures(line, this.catalog);
        } else {
          if (event.Action !== "fail" || typeof event.Test !== "string") return;
          matches = this.catalog().filter(
            (row) => row.name === event.Test.split("/")[0],
          );
          if (matches.length > 1 && typeof event.Package === "string")
            matches = matches.filter((row) =>
              event.Package.endsWith(
                dirname(row.file).replace(
                  /^(?:services|tests\/integration)\//u,
                  "/",
                ),
              ),
            );
        }
      } else if (/^FAIL\s/u.test(line)) {
        const [, path, title = ""] =
          /^FAIL\s+(\S+)(?:\s+>\s+(.*))?$/u.exec(line) ?? [];
        if (!path) return;
        const relative = path.replace(/^(?:\.\.\/)+/u, "");
        const files = this.catalog().filter(
          (row) =>
            relative === row.file ||
            path === resolve(root, row.file) ||
            row.file.endsWith(`/${relative}`),
        );
        const names = title.split(" > ");
        matches = files.filter((row) => row.name && names.at(-1) === row.name);
        if (!matches.length && new Set(files.map((row) => row.file)).size === 1)
          matches = [
            {
              name: "[dynamic test name omitted]",
              file: files[0].file,
              line: 1,
            },
          ];
      }
      if (matches.length !== 1) return;
      const { name, file, line: sourceLine } = matches[0];
      const key = `${file}:${sourceLine}:${name}`;
      if (this.seen.has(key) || this.seen.size >= 100) return;
      this.seen.add(key);
      const row = {
        version: 1,
        name,
        file,
        line: sourceLine,
        category: "test_failure",
        reportedAt: this.now(),
      };
      this.failures.push(row);
      this.report(row);
    } catch {
      // Diagnostics never replace the command's exit/cleanup admission.
    }
  }
}

export function reportedFailures(output, catalog = sourceCatalog) {
  const found = new Map();
  for (const line of output.split(/\r?\n/u)) {
    try {
      const row = JSON.parse(line).ci_failure;
      if (
        row?.version !== 1 ||
        row.category !== "test_failure" ||
        !Number.isFinite(row.reportedAt)
      )
        continue;
      const known = catalog().some(
        (entry) =>
          entry.file === row.file &&
          ((entry.name === row.name && entry.line === row.line) ||
            (row.name === "[dynamic test name omitted]" && row.line === 1)),
      );
      if (!known) continue;
      const safe = {
        version: 1,
        name: row.name,
        file: row.file,
        line: row.line,
        category: "test_failure",
        reportedAt: row.reportedAt,
      };
      found.set(`${safe.file}:${safe.line}:${safe.name}`, safe);
      if (found.size === 100) break;
    } catch {
      /* Ordinary command output is not necessarily JSON. */
    }
  }
  return [...found.values()];
}
