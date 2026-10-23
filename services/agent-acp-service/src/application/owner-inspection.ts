import {
  OwnerIncarnationError,
  parseOwnerRegistration,
  type OwnerRegistration,
} from "./owner-incarnation.js";

const unknownReasons = [
  "unregistered",
  "platform_unavailable",
  "engine_changed",
  "membership_unavailable",
] as const;
const stopReasons = ["container_stopped", "container_restarted", "container_removed"] as const;

export type OwnerStopReceipt = Readonly<{
  receipt_id: string;
  reason: (typeof stopReasons)[number];
  observed_at: string;
}>;

export type OwnerInspection =
  | Readonly<OwnerRegistration & { state: "running"; observed_at: string }>
  | Readonly<OwnerRegistration & { state: "stopped"; stop_receipt: OwnerStopReceipt }>
  | Readonly<{
      state: "unknown";
      registration_id: string;
      reason: (typeof unknownReasons)[number];
    }>;

// A stop receipt is meaningful only with its complete registered binding.
// Timestamps remain diagnostics: freshness never establishes stop authority.
export function parseOwnerInspection(value: unknown, expected: OwnerRegistration): OwnerInspection {
  try {
    const original = parseOwnerRegistration(expected);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const state: unknown = (value as Record<string, unknown>).state;
    if (state === "unknown") {
      const record = exactRecord(value, ["state", "registration_id", "reason"]);
      if (record.registration_id !== original.registration_id) throw new Error();
      const reason = reasonValue(record.reason, unknownReasons);
      return Object.freeze({ state, registration_id: original.registration_id, reason });
    }
    if (state !== "running" && state !== "stopped") throw new Error();
    const record = exactRecord(value, [
      "state",
      "registration_id",
      "member_id",
      "incarnation_id",
      state === "running" ? "observed_at" : "stop_receipt",
    ]);
    const binding = parseOwnerRegistration({
      registration_id: record.registration_id,
      member_id: record.member_id,
      incarnation_id: record.incarnation_id,
    });
    if (
      binding.registration_id !== original.registration_id ||
      binding.member_id !== original.member_id ||
      binding.incarnation_id !== original.incarnation_id
    )
      throw new Error();
    if (state === "running")
      return Object.freeze({ state, ...binding, observed_at: timestamp(record.observed_at) });
    const receipt = exactRecord(record.stop_receipt, ["receipt_id", "reason", "observed_at"]);
    const receiptId = receipt.receipt_id;
    if (
      typeof receiptId !== "string" ||
      receiptId.length !== 36 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(receiptId)
    )
      throw new Error();
    const stopReceipt: OwnerStopReceipt = Object.freeze({
      receipt_id: receiptId,
      reason: reasonValue(receipt.reason, stopReasons),
      observed_at: timestamp(receipt.observed_at),
    });
    return Object.freeze({ state, ...binding, stop_receipt: stopReceipt });
  } catch {
    throw new OwnerIncarnationError("acp_registry_unavailable");
  }
}

function exactRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    throw new Error();
  return value as Record<string, unknown>;
}

function reasonValue<T extends string>(value: unknown, allowed: readonly T[]): T {
  const found = allowed.find((reason) => reason === value);
  if (found === undefined) throw new Error();
  return found;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string") throw new Error();
  const match = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.exec(value);
  if (match?.[0] !== value) throw new Error();
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().slice(0, 19) !== value.slice(0, 19)
  )
    throw new Error();
  return value;
}
