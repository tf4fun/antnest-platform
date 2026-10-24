import { isDeepStrictEqual } from "node:util";
import { DomainError } from "../domain/errors.js";
import type { PeerParticipation, PeerParticipationGuard } from "../ports/peer-participation.js";
import { parseOwnerRegistration, type OwnerRegistration } from "./owner-incarnation.js";
import { parseOwnerInspection, type OwnerInspection } from "./owner-inspection.js";
import { parseOwnerHistoryPage, type OwnerHistoryRequest } from "./owner-history.js";

type Stopped = Extract<OwnerInspection, { state: "stopped" }>;
export type AvailableMember = Readonly<
  | {
      memberId: string;
      state: "running";
      registration: OwnerRegistration;
      stopped: readonly Stopped[];
    }
  | { memberId: string; state: "stopped"; stopped: readonly Stopped[] }
  | { memberId: string; state: "unregistered" }
>;
export type PeerAvailabilityCapture = Readonly<{
  guard: PeerParticipationGuard;
  members: readonly AvailableMember[];
  live: readonly OwnerRegistration[];
}>;
type Options = {
  registration: OwnerRegistration;
  membershipSha256: string;
  members: readonly string[];
  ledger: PeerParticipation;
  registry: {
    history(input: OwnerHistoryRequest, signal: AbortSignal): Promise<unknown>;
    inspect(input: OwnerRegistration, signal: AbortSignal): Promise<unknown>;
  };
};
const unavailable = () =>
  new DomainError("configuration_unavailable", "ACP member participation cannot be confirmed");

/** RC history proves original process facts; the separate SQL version fences activation. */
export class PeerAvailability {
  private readonly registration: OwnerRegistration;
  private readonly members: readonly string[];
  private latest: PeerAvailabilityCapture | undefined;
  private started = 0;
  private published = 0;
  public constructor(private readonly options: Options) {
    this.registration = parseOwnerRegistration(options.registration);
    if (
      !/^[a-f0-9]{64}$/u.test(options.membershipSha256) ||
      options.members.length < 1 ||
      options.members.length > 64 ||
      new Set(options.members).size !== options.members.length ||
      !options.members.includes(this.registration.member_id) ||
      options.members.some(
        (member) =>
          member.length > 64 || /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.exec(member)?.[0] !== member,
      )
    )
      throw unavailable();
    this.members = Object.freeze([...options.members].sort());
  }
  public current(): PeerAvailabilityCapture {
    if (this.latest === undefined) throw unavailable();
    return this.latest;
  }
  public async refresh(signal: AbortSignal, deadline: number): Promise<PeerAvailabilityCapture> {
    if (!Number.isSafeInteger(deadline) || deadline <= Date.now() || deadline > Date.now() + 10000)
      throw unavailable();
    const attempt = ++this.started;
    const timeout = new AbortController();
    const lifetime = AbortSignal.any([signal, timeout.signal]);
    const timer = setTimeout(() => timeout.abort(unavailable()), deadline - Date.now());
    timer.unref();
    const current = () => {
      lifetime.throwIfAborted();
      if (Date.now() >= deadline) throw unavailable();
    };
    try {
      current();
      // Capture first. A later registration cannot enter between discovery and
      // acknowledgement/acquisition without invalidating this exact version.
      const captured = await this.options.ledger.capture();
      current();
      if (
        captured.membershipSha256 !== this.options.membershipSha256 ||
        !/^(?:0|[1-9][0-9]*)$/u.test(captured.revision) ||
        BigInt(captured.revision) > 9223372036854775807n
      )
        throw unavailable();
      const guard = Object.freeze({
        membershipSha256: captured.membershipSha256,
        revision: captured.revision,
      });
      const admitted = captured.registrations.map(parseOwnerRegistration);
      if (
        new Set(admitted.map((r) => r.registration_id)).size !== admitted.length ||
        admitted.some((r) => !this.members.includes(r.member_id)) ||
        !admitted.some((r) => isDeepStrictEqual(r, this.registration))
      )
        throw unavailable();
      const results = await Promise.allSettled(
        this.members.map(async (memberId): Promise<AvailableMember> => {
          const discovered = new Map<string, OwnerRegistration>();
          const incarnations = new Set<string>();
          const stopped: Stopped[] = [];
          let running: OwnerRegistration | undefined;
          let input: OwnerHistoryRequest = { member_id: memberId, cursor: null };
          for (;;) {
            current();
            const page = parseOwnerHistoryPage(
              await this.options.registry.history(input, lifetime),
              input,
            );
            current();
            for (const item of page.items) {
              const original = item.registration;
              if (
                discovered.has(original.registration_id) ||
                incarnations.has(original.incarnation_id)
              )
                throw unavailable();
              discovered.set(original.registration_id, original);
              incarnations.add(original.incarnation_id);
              const inspection = parseOwnerInspection(
                await this.options.registry.inspect(original, lifetime),
                original,
              );
              current();
              if (inspection.state === "stopped") stopped.push(inspection);
              else if (
                inspection.state === "running" &&
                running === undefined &&
                admitted.some((r) => isDeepStrictEqual(r, original))
              )
                running = original;
              else throw unavailable();
            }
            if (page.next_cursor === null) break;
            input = { member_id: memberId, cursor: page.next_cursor };
          }
          if (
            admitted.some(
              (r) =>
                r.member_id === memberId &&
                !isDeepStrictEqual(discovered.get(r.registration_id), r),
            )
          )
            throw unavailable();
          Object.freeze(stopped);
          if (running !== undefined)
            return Object.freeze({ memberId, state: "running", registration: running, stopped });
          if (stopped.length > 0) return Object.freeze({ memberId, state: "stopped", stopped });
          return Object.freeze({ memberId, state: "unregistered" });
        }),
      );
      const failures = results
        .filter((r) => r.status === "rejected")
        .map((r) => r.reason as unknown);
      if (failures.length) {
        const error = unavailable();
        error.cause = new AggregateError(failures, "Original member discovery failed");
        throw error;
      }
      current();
      const members = results.map((r) => {
        if (r.status !== "fulfilled") throw unavailable();
        return r.value;
      });
      const live = members.flatMap((m) => (m.state === "running" ? [m.registration] : []));
      if (!live.some((r) => isDeepStrictEqual(r, this.registration))) throw unavailable();
      await this.options.ledger.assert(guard, { timeoutMs: deadline - Date.now() });
      current();
      const next = Object.freeze({
        guard,
        members: Object.freeze(members),
        live: Object.freeze(live),
      });
      if (attempt < this.published) {
        // A concurrent refresh of the same fully verified capture is harmless.
        // Never replace newer membership or resurrect a peer proved stopped.
        if (this.latest !== undefined && isDeepStrictEqual(next, this.latest)) return this.latest;
        throw unavailable();
      }
      this.latest = next;
      this.published = attempt;
      return next;
    } finally {
      clearTimeout(timer);
    }
  }
}
