// Gates a suite that exited 2 (business and topology passed, strict trace
// findings remain). Jaeger clock skew adjustments are the only reviewed
// warning; error spans on denial and cancellation paths are recorded by
// contract (docs/observability-contract.md) and checked by each runner's
// topology. Any other Jaeger warning fails the suite.
export const clockSkewWarning =
  /^clock skew adjustment disabled; not applying calculated delta of -?[0-9.]+(?:ns|µs|ms|s)$/u;

function collect(value, found) {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, found);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "warnings" && Array.isArray(item))
        found.push(...item.filter((warning) => typeof warning === "string"));
      else collect(item, found);
    }
  }
}

export function unreviewedWarnings(output) {
  const warnings = [];
  for (const line of output.split(/\r?\n/u)) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    let record;
    try {
      record = JSON.parse(text);
    } catch {
      continue;
    }
    collect(record, warnings);
  }
  return [...new Set(warnings.filter((w) => !clockSkewWarning.test(w)))];
}
