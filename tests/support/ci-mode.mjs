import { pathToFileURL } from "node:url";

// Every head of a pull request in review runs the integration suites; a draft
// runs only repository and service checks until it is marked ready.
const REVIEW_ACTIONS = new Set([
  "opened",
  "reopened",
  "ready_for_review",
  "synchronize",
]);

/**
 * full: select and run integration suites and report `Integration checks`.
 * light: run nothing; the required check stays pending for this head.
 * ignored: an event that must not start or replace an integration run.
 */
export function integrationMode({ event, action, draft }) {
  if (event !== "pull_request") return "full";
  if (!REVIEW_ACTIONS.has(action)) return "ignored";
  return draft ? "light" : "full";
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { EVENT, ACTION = "", DRAFT = "false" } = process.env;
  if (!EVENT) {
    process.stderr.write("EVENT is required\n");
    process.exit(2);
  }
  const mode = integrationMode({
    event: EVENT,
    action: ACTION,
    draft: DRAFT === "true",
  });
  process.stdout.write(`mode=${mode}\n`);
}
