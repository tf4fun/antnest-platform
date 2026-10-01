import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const linkPattern = /\]\((<[^>\n]+>|[^)\s]+)(?:\s+"[^"]*")?\)/g;

export function relativeLinkTargets(markdown) {
  const targets = [];
  // Code shows literal syntax and is not navigable documentation.
  const prose = markdown
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "")
    .replace(/`[^`\n]*`/g, "");
  for (const match of prose.matchAll(linkPattern)) {
    const raw = match[1].replace(/^<|>$/g, "");
    const target = raw.split("#", 1)[0];
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    targets.push(target);
  }
  return targets;
}

export function brokenMarkdownLinks(root, files) {
  const broken = [];
  for (const file of files) {
    const markdown = readFileSync(join(root, file), "utf8");
    for (const target of relativeLinkTargets(markdown)) {
      const resolved = target.startsWith("/")
        ? join(root, target)
        : join(root, dirname(file), decodeURIComponent(target));
      if (!existsSync(normalize(resolved))) broken.push({ file, target });
    }
  }
  return broken;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const files = execFileSync("git", ["ls-files", "--", "*.md"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter((file) => file && existsSync(join(root, file)));
  const broken = brokenMarkdownLinks(root, files);
  for (const { file, target } of broken) console.error(`${file}: ${target}`);
  if (broken.length) {
    console.error(`${broken.length} broken relative Markdown links`);
    process.exitCode = 1;
  } else {
    console.log(`checked ${files.length} Markdown files`);
  }
}
