import type { OwnerRegistration } from "../application/owner-incarnation.js";
import type { ExecutionPublication } from "../domain/execution-publication.js";

/** Private peer transport failure; public operations map it to their own catalog. */
export class PeerDeadlineError extends Error {
  public readonly code = "deadline_exceeded";

  public constructor(message = "ACP peer deadline exceeded") {
    super(message);
    this.name = "PeerDeadlineError";
  }
}

export type PeerIdentityRequest = Readonly<{
  request_id: string;
  deadline_at: string;
  membership_sha256: string;
  source: Readonly<OwnerRegistration>;
  target_member_id: string;
  challenge: string;
}>;

export type PeerPublicationRequest = Readonly<{
  request_id: string;
  deadline_at: string;
  membership_sha256: string;
  source: Readonly<OwnerRegistration>;
  target: Readonly<OwnerRegistration>;
  publication: ExecutionPublication;
  hop: 1;
}>;

/** Destinations and credentials come from operator configuration, never wire bodies. */
export interface AgentPeers {
  identify(memberId: string, request: PeerIdentityRequest, signal: AbortSignal): Promise<unknown>;
  publish(memberId: string, request: PeerPublicationRequest, signal: AbortSignal): Promise<unknown>;
}
