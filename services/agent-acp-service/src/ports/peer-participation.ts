import type { OwnerRegistration } from "../application/owner-incarnation.js";

export type PeerParticipationGuard = Readonly<{ membershipSha256: string; revision: string }>;
export type PeerParticipationCapture = PeerParticipationGuard &
  Readonly<{
    registrations: readonly OwnerRegistration[];
  }>;
export interface PeerParticipation {
  capture(): Promise<PeerParticipationCapture>;
  assert(capture: PeerParticipationGuard, options?: { timeoutMs?: number }): Promise<void>;
}
