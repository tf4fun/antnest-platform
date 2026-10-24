import { z } from "zod";
import { DomainError } from "./errors.js";
import { MAX_AGENT_LEASE_EPOCH } from "./agent-ownership.js";

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const registration = z.strictObject({
  registration_id: uuid,
  member_id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u),
  incarnation_id: uuid,
});
const identityReceipt = z.strictObject({
  request_id: uuid,
  membership_sha256: digest,
  challenge: digest,
  registration,
});
const publicationReceipt = z.strictObject({
  request_id: uuid,
  membership_sha256: digest,
  publication: z.strictObject({
    organization_id: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => value.trim() === value),
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    authority_sha256: digest,
  }),
  registration,
  status: z.literal("applied"),
  revocation: z.literal("joined"),
  owned_agents: z
    .array(
      z.strictObject({
        agent_id: z
          .string()
          .min(1)
          .max(200)
          .refine((value) => value.trim() === value),
        epoch: z
          .string()
          .regex(/^[1-9][0-9]{0,18}$/u)
          .refine(
            (value) =>
              /^[1-9][0-9]{0,18}$/u.test(value) && BigInt(value) <= BigInt(MAX_AGENT_LEASE_EPOCH),
          ),
      }),
    )
    .max(65536),
});
export type PeerPublicationReceipt = z.infer<typeof publicationReceipt>;

export function parsePeerIdentityReceipt(input: unknown): z.infer<typeof identityReceipt> {
  const parsed = identityReceipt.safeParse(input);
  if (!parsed.success) throw unavailable();
  return parsed.data;
}

export function parsePeerPublicationReceipt(input: unknown): PeerPublicationReceipt {
  const parsed = publicationReceipt.safeParse(input);
  if (!parsed.success) throw unavailable();
  if (
    new Set(parsed.data.owned_agents.map((agent) => agent.agent_id)).size !==
    parsed.data.owned_agents.length
  )
    throw unavailable();
  return parsed.data;
}

function unavailable(): DomainError {
  return new DomainError("configuration_unavailable", "Peer publication receipt is invalid");
}
