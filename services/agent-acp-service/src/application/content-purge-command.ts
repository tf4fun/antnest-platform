import { emptyPurgeCounts, type ContentPurger } from "../domain/content-retention.js";

export type ContentPurgeSelector =
  | Readonly<{ organizationId: string }>
  | Readonly<{ principalId: string }>
  | Readonly<{ sessionId: string }>;

export type ContentPurgeArguments = {
  selector: ContentPurgeSelector;
  dryRun: boolean;
};

const SELECTORS = new Map([
  ["--organization", "organizationId"],
  ["--user", "principalId"],
  ["--session", "sessionId"],
] as const);

const SELECTOR_MAXIMUM = 200;

function invalid(message: string): Error {
  return new Error(`Invalid content purge arguments: ${message}`);
}

function selectorValue(value: string | undefined): string {
  if (
    value === undefined ||
    value.length === 0 ||
    value !== value.trim() ||
    value.length > SELECTOR_MAXIMUM ||
    value.startsWith("-")
  )
    throw invalid("selector requires one nonempty value");
  return value;
}

export function parseContentPurgeArguments(args: readonly string[]): ContentPurgeArguments {
  let selector: ContentPurgeSelector | undefined;
  let mode: "dry-run" | "confirm" | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("--")) throw invalid(`unexpected argument ${JSON.stringify(token)}`);
    if (seen.has(token)) throw invalid(`duplicate flag ${token}`);
    seen.add(token);
    const key = SELECTORS.get(token as "--organization" | "--user" | "--session");
    if (key !== undefined) {
      if (selector !== undefined) throw invalid("exactly one scope selector is required");
      selector = Object.freeze({ [key]: selectorValue(args[index + 1]) }) as ContentPurgeSelector;
      index += 1;
      continue;
    }
    if (token === "--dry-run" || token === "--confirm") {
      if (mode !== undefined) throw invalid("exactly one of --dry-run or --confirm is required");
      mode = token === "--dry-run" ? "dry-run" : "confirm";
      continue;
    }
    throw invalid(`unknown flag ${token}`);
  }
  if (selector === undefined) throw invalid("exactly one scope selector is required");
  if (mode === undefined) throw invalid("exactly one of --dry-run or --confirm is required");
  return { selector, dryRun: mode === "dry-run" };
}

export async function runContentPurgeCommand(input: {
  args: readonly string[];
  purge: ContentPurger;
  batchLimit: number;
  out: (line: string) => void;
  signal: AbortSignal;
}): Promise<number> {
  const parsed = parseContentPurgeArguments(input.args);
  const totals = { scanned: 0, blocked: 0, counts: emptyPurgeCounts() };
  let after: string | null = null;
  do {
    const result = await input.purge.batch({
      ...parsed.selector,
      ...(after === null ? {} : { after }),
      limit: input.batchLimit,
      dryRun: parsed.dryRun,
      waitForLocks: true,
      signal: input.signal,
    });
    totals.scanned += result.scanned;
    totals.blocked += result.blocked;
    for (const key of Object.keys(totals.counts) as (keyof typeof totals.counts)[])
      totals.counts[key] += result.counts[key];
    after = result.nextCursor;
  } while (after !== null);
  input.out(
    JSON.stringify({
      dryRun: parsed.dryRun,
      scanned: totals.scanned,
      blocked: totals.blocked,
      counts: totals.counts,
    }),
  );
  return totals.blocked === 0 ? 0 : 1;
}
