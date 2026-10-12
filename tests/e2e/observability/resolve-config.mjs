import assert from "node:assert/strict";
import { evidenceDirectory } from "../../support/storage.mjs";

const invalid = () => new Error("invalid observability Resolve configuration");
const units = {
  ns: 1n,
  us: 1000n,
  µs: 1000n,
  μs: 1000n,
  ms: 1000000n,
  s: 1000000000n,
  m: 60000000000n,
  h: 3600000000000n,
};

// Gateway uses time.ParseDuration and stores nanoseconds. Preserve its
// per-component truncation and float64 fractional-unit rounding, including
// sub-millisecond TTLs, instead of parseInt or a seconds-only approximation.
function durationMS(value) {
  const negative = value.startsWith("-");
  if (/^[+-]/u.test(value)) value = value.slice(1);
  if (value === "0") return 0;
  assert(value);
  let nanoseconds = 0n;
  while (value) {
    const part = /^([0-9]*)(?:\.([0-9]*))?(ns|us|µs|μs|ms|s|m|h)/u.exec(value);
    assert(part && (part[1] || part[2]));
    const unit = units[part[3]];
    let fraction = 0n,
      scale = 1;
    for (const digit of part[2] ?? "") {
      if (fraction > ((1n << 63n) - 1n) / 10n) break;
      const next = fraction * 10n + BigInt(digit);
      if (next > 1n << 63n) break;
      fraction = next;
      scale *= 10;
    }
    nanoseconds += BigInt(part[1] || "0") * unit;
    if (fraction > 0n)
      nanoseconds += BigInt(
        Math.trunc(Number(fraction) * (Number(unit) / scale)),
      );
    assert(nanoseconds <= 30000000000n);
    value = value.slice(part[0].length);
  }
  assert(!negative || nanoseconds === 0n);
  return Number(nanoseconds) / 1000000;
}

export function resolveObservationConfig(settings, environment = process.env) {
  try {
    const value = (key) => {
      const raw = environment[key] ?? settings[key] ?? "";
      assert.equal(typeof raw, "string");
      // Go strings.TrimSpace follows Unicode White_Space: it includes NEL
      // and excludes the BOM, unlike JavaScript String.prototype.trim.
      return raw.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
    };
    const capture = value(
      "ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT",
    ).toLowerCase();
    assert(["", "true", "false"].includes(capture));
    return {
      resolveTTLMS: durationMS(
        value("ANTNEST_EDGE_RESOLVE_CACHE_TTL") || "10s",
      ),
      captureRpcContent: capture === "true",
    };
  } catch {
    throw invalid();
  }
}

export function offlineResolveConfig(values) {
  try {
    assert.equal(typeof values["capture-rpc-content"], "boolean");
    const raw = values["resolve-ttl-ms"];
    assert(
      typeof raw === "string" && /^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(raw),
    );
    assert((raw.split(".")[1] ?? "").replace(/0+$/u, "").length <= 6);
    const resolveTTLMS = Number(raw);
    assert(
      Number.isFinite(resolveTTLMS) &&
        resolveTTLMS >= 0 &&
        resolveTTLMS <= 30000,
    );
    return { resolveTTLMS, captureRpcContent: values["capture-rpc-content"] };
  } catch {
    throw invalid();
  }
}

export function requireResolveEvidenceDirectory(value) {
  const directory = evidenceDirectory(value);
  assert(directory, "--resolve-evidence-directory is required");
  return directory;
}
