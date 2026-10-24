import { z } from "zod";
import { parseOwnerRegistration, type OwnerRegistration } from "./owner-incarnation.js";

const position = z
  .string()
  .max(19)
  .regex(/^(?:0|[1-9][0-9]*)$/u)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
const uuid = z
  .string()
  .length(36)
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
const member = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u);
const cursorSchema = z
  .strictObject({
    history_id: uuid,
    snapshot_revision: position,
    after_sequence: position,
  })
  .refine((value) => BigInt(value.after_sequence) < BigInt(value.snapshot_revision));
const requestSchema = z.strictObject({ member_id: member, cursor: cursorSchema.nullable() });
const pageSchema = z.strictObject({
  member_id: member,
  history_id: uuid,
  snapshot_revision: position,
  after_sequence: position,
  items: z
    .array(
      z.strictObject({
        sequence: position,
        registration: z.unknown().transform(parseOwnerRegistration),
      }),
    )
    .max(64),
  next_cursor: cursorSchema.nullable(),
});

export type OwnerHistoryCursor = Readonly<z.infer<typeof cursorSchema>>;
export type OwnerHistoryRequest = Readonly<{
  member_id: string;
  cursor: OwnerHistoryCursor | null;
}>;
export type OwnerHistoryPage = Readonly<{
  member_id: string;
  history_id: string;
  snapshot_revision: string;
  after_sequence: string;
  items: readonly Readonly<{ sequence: string; registration: OwnerRegistration }>[];
  next_cursor: OwnerHistoryCursor | null;
}>;

export function parseOwnerHistoryRequest(input: unknown): OwnerHistoryRequest {
  const value = requestSchema.parse(input);
  if (value.cursor !== null) Object.freeze(value.cursor);
  return Object.freeze(value);
}

export function parseOwnerHistoryPage(
  input: unknown,
  request: OwnerHistoryRequest,
): OwnerHistoryPage {
  const expected = parseOwnerHistoryRequest(request);
  const value = pageSchema.parse(input);
  const revision = BigInt(value.snapshot_revision),
    after = BigInt(value.after_sequence);
  const cursor = expected.cursor;
  if (
    value.member_id !== expected.member_id ||
    after > revision ||
    (cursor === null
      ? after !== 0n
      : value.history_id !== cursor.history_id ||
        value.snapshot_revision !== cursor.snapshot_revision ||
        value.after_sequence !== cursor.after_sequence) ||
    BigInt(value.items.length) !== (revision - after > 64n ? 64n : revision - after)
  )
    throw new Error("Incomplete ACP member history");
  const registrations = new Set<string>(),
    incarnations = new Set<string>();
  for (const [index, item] of value.items.entries()) {
    if (
      BigInt(item.sequence) !== after + BigInt(index) + 1n ||
      item.registration.member_id !== expected.member_id ||
      registrations.has(item.registration.registration_id) ||
      incarnations.has(item.registration.incarnation_id)
    )
      throw new Error("Invalid ACP member history identity or order");
    registrations.add(item.registration.registration_id);
    incarnations.add(item.registration.incarnation_id);
    Object.freeze(item);
  }
  const last = after + BigInt(value.items.length),
    next = value.next_cursor;
  if (
    last === revision
      ? next !== null
      : next === null ||
        next.history_id !== value.history_id ||
        next.snapshot_revision !== value.snapshot_revision ||
        next.after_sequence !== String(last)
  )
    throw new Error("Invalid ACP member history continuation");
  Object.freeze(value.items);
  if (next !== null) Object.freeze(next);
  return Object.freeze(value);
}
