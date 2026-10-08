import { pathToFileURL } from "node:url";

// Every push to a pull request runs only repository and service checks; the
// integration suites run when a pull request enters review or a maintainer
// asks for them with this label.
export const FULL_LABEL = "ci:full";

const ENTRY_ACTIONS = new Set(["opened", "reopened", "ready_for_review"]);

/**
 * full: select and run integration suites and report `Integration checks`.
 * light: run nothing; the required check stays pending for this head.
 * ignored: an event that must not start or replace an integration run.
 */
export function integrationMode({ event, action, draft, label }) {
  if (event !== "pull_request") return "full";
  if (ENTRY_ACTIONS.has(action)) return draft ? "light" : "full";
  if (action === "labeled") return label === FULL_LABEL ? "full" : "ignored";
  if (action === "synchronize") return "light";
  return "ignored";
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { EVENT, ACTION = "", DRAFT = "false", LABEL = "" } = process.env;
  if (!EVENT) {
    process.stderr.write("EVENT is required\n");
    process.exit(2);
  }
  const mode = integrationMode({
    event: EVENT,
    action: ACTION,
    draft: DRAFT === "true",
    label: LABEL,
  });
  process.stdout.write(`mode=${mode}\n`);
}
