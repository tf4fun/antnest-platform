import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect, isDeepStrictEqual } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { RuntimeControllerIncarnations } from "../../../../services/agent-acp-service/src/adapters/runtime-controller-incarnations.js";
import { ServiceAuthentication } from "../../../../services/agent-acp-service/src/adapters/service-authentication.js";
import {
  OwnerIncarnationError,
  type OwnerRegistration,
} from "../../../../services/agent-acp-service/src/application/owner-incarnation.js";

type Inspection =
  | (OwnerRegistration & { state: "running"; observed_at: string })
  | (OwnerRegistration & {
      state: "stopped";
      stop_receipt: {
        receipt_id: string;
        reason: StopReason;
        observed_at: string;
      };
    })
  | { state: "unknown"; registration_id: string; reason: UnknownReason };
type StopReason =
  "container_stopped" | "container_restarted" | "container_removed";
type UnknownReason =
  | "unregistered"
  | "platform_unavailable"
  | "engine_changed"
  | "membership_unavailable";

const registration: OwnerRegistration = {
  registration_id: "cafe1234-cafe-4abc-8abc-1234567890ab",
  member_id: "acp-a",
  incarnation_id: "12345678-1234-4abc-8abc-1234567890ab",
};
const otherUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const observedAt = "2026-10-23T12:34:56.123456789Z";
const privateCause = "PRIVATE_INSPECTION_PEER_CAUSE";
const running: Inspection = {
  ...registration,
  state: "running",
  observed_at: observedAt,
};
const stopped: Extract<Inspection, { state: "stopped" }> = {
  ...registration,
  state: "stopped",
  stop_receipt: {
    receipt_id: "beef1234-beef-4abc-8abc-1234567890ab",
    reason: "container_stopped",
    observed_at: observedAt,
  },
};
const unknown: Inspection = {
  state: "unknown",
  registration_id: registration.registration_id,
  reason: "unregistered",
};

describe("Runtime Controller incarnation inspection over real HTTP", () => {
  const valid: Array<{ name: string; value: Inspection }> = [
    { name: "running with nanoseconds", value: running },
    {
      name: "running without fractional seconds",
      value: { ...running, observed_at: "2026-10-23T12:34:56Z" },
    },
    {
      name: "stop receipt without fractional seconds",
      value: {
        ...stopped,
        stop_receipt: {
          ...stopped.stop_receipt,
          observed_at: "2026-10-23T12:34:56Z",
        },
      },
    },
    ...(
      ["container_stopped", "container_restarted", "container_removed"] as const
    ).map((reason) => ({
      name: reason,
      value: { ...stopped, stop_receipt: { ...stopped.stop_receipt, reason } },
    })),
    ...(
      [
        "unregistered",
        "platform_unavailable",
        "engine_changed",
        "membership_unavailable",
      ] as const
    ).map((reason) => ({
      name: reason,
      value: {
        state: "unknown" as const,
        registration_id: registration.registration_id,
        reason,
      },
    })),
  ];
  it.each(valid)(
    "retains the complete $name wire result and exact workload request",
    async ({ value }) => {
      await withInspectionPeer(
        ({ response }) => {
          response.end(JSON.stringify(value));
        },
        async (peer) => {
          const expected = structuredClone(registration);
          const original = structuredClone(expected);
          const pending = peer.start(expected);
          expectInspection(await deadline(pending.promise), value);
          expect(
            isDeepStrictEqual(expected, original),
            "inspection mutated its expected binding",
          ).toBe(true);
          expect(peer.calls).toHaveLength(1);
          const call = peer.calls[0];
          if (call === undefined)
            throw new Error("missing actual inspection request");
          expect(call.method).toBe("GET");
          expect(call.path).toBe(
            `/internal/acp-incarnations/${registration.registration_id}`,
          );
          expect(call.body.byteLength).toBe(0);
          expect(call.headers["content-type"]).toBeUndefined();
          expect(call.headers["cache-control"]).toBe("no-store");
          expect(
            call.headers["antnest-service-authorization"] ===
              `Bearer ${peer.token}`,
            "inspection lost its workload credential",
          ).toBe(true);
          for (const header of [
            "authorization",
            "cookie",
            "antnest-caller-context",
          ])
            expect(
              call.headers[header],
              "inspection forwarded user authority",
            ).toBeUndefined();
          expect(
            Object.keys(call.headers).some((name) =>
              name.startsWith("x-antnest-"),
            ),
          ).toBe(false);
          await deadline(call.finished);
          await deadline(call.socketClosed);
          expect(peer.authentication.flights).toHaveLength(1);
          expectBodiesJoined(peer.authentication);
        },
      );
    },
  );

  const invalid: Array<{ name: string; body: string; media?: string | null }> =
    [
      { name: "null", body: "null" },
      { name: "array", body: "[]" },
      {
        name: "unknown state",
        body: JSON.stringify({ ...stopped, state: "dead" }),
      },
      { name: "missing state", body: JSON.stringify(registration) },
      {
        name: "null observation",
        body: JSON.stringify({ ...running, observed_at: null }),
      },
      {
        name: "non-string binding",
        body: JSON.stringify({ ...running, member_id: 7 }),
      },
      {
        name: "null receipt",
        body: JSON.stringify({ ...stopped, stop_receipt: null }),
      },
      {
        name: "array receipt",
        body: JSON.stringify({ ...stopped, stop_receipt: [] }),
      },
      {
        name: "unknown stop reason",
        body: JSON.stringify({
          ...stopped,
          stop_receipt: {
            ...stopped.stop_receipt,
            reason: "container_unreachable",
          },
        }),
      },
      {
        name: "unknown unknown reason",
        body: JSON.stringify({ ...unknown, reason: "not_found" }),
      },
      {
        name: "running stop proof",
        body: JSON.stringify({
          ...running,
          stop_receipt: stopped.stop_receipt,
        }),
      },
      {
        name: "unknown stop proof",
        body: JSON.stringify({
          ...unknown,
          stop_receipt: stopped.stop_receipt,
        }),
      },
      {
        name: "unknown member binding",
        body: JSON.stringify({ ...unknown, member_id: registration.member_id }),
      },
      {
        name: "unknown incarnation binding",
        body: JSON.stringify({
          ...unknown,
          incarnation_id: registration.incarnation_id,
        }),
      },
      {
        name: "stopped running observation",
        body: JSON.stringify({ ...stopped, observed_at: observedAt }),
      },
      {
        name: "extra root credential",
        body: JSON.stringify({ ...running, credential: privateCause }),
      },
      {
        name: "extra receipt field",
        body: JSON.stringify({
          ...stopped,
          stop_receipt: { ...stopped.stop_receipt, quiescent: true },
        }),
      },
      {
        name: "uppercase registration UUID",
        body: JSON.stringify({
          ...running,
          registration_id: registration.registration_id.toUpperCase(),
        }),
      },
      {
        name: "non-v4 incarnation UUID",
        body: JSON.stringify({
          ...running,
          incarnation_id: registration.incarnation_id.replace(
            "-4abc-",
            "-1abc-",
          ),
        }),
      },
      {
        name: "uppercase receipt UUID",
        body: JSON.stringify({
          ...stopped,
          stop_receipt: {
            ...stopped.stop_receipt,
            receipt_id: stopped.stop_receipt.receipt_id.toUpperCase(),
          },
        }),
      },
      {
        name: "non-v4 receipt UUID",
        body: JSON.stringify({
          ...stopped,
          stop_receipt: {
            ...stopped.stop_receipt,
            receipt_id: stopped.stop_receipt.receipt_id.replace(
              "-4abc-",
              "-1abc-",
            ),
          },
        }),
      },
      {
        name: "duplicate state",
        body: JSON.stringify(running).replace(
          '"state":"running"',
          '"state":"running","state":"running"',
        ),
      },
      {
        name: "decoded duplicate state",
        body: JSON.stringify(running).replace(
          '"state":"running"',
          String.raw`"state":"running","\u0073tate":"running"`,
        ),
      },
      {
        name: "case alias",
        body: JSON.stringify(running).replace('"member_id":', '"Member_id":'),
      },
      {
        name: "nested duplicate reason",
        body: JSON.stringify(stopped).replace(
          '"reason":"container_stopped"',
          '"reason":"container_stopped","reason":"container_stopped"',
        ),
      },
      { name: "second document", body: JSON.stringify(stopped) + " {}" },
      { name: "malformed JSON", body: '{"state":"stopped",' },
      {
        name: "wrong media",
        body: JSON.stringify(stopped),
        media: "text/plain",
      },
      { name: "missing media", body: JSON.stringify(stopped), media: null },
      {
        name: "non-UTF-8 media",
        body: JSON.stringify(stopped),
        media: "application/json; charset=iso-8859-1",
      },
    ];
  for (const value of [running, stopped, unknown]) {
    for (const field of Object.keys(value).filter(
      (field) => field !== "state",
    )) {
      const body: Record<string, unknown> = { ...value };
      delete body[field];
      invalid.push({
        name: `${value.state} missing ${field}`,
        body: JSON.stringify(body),
      });
    }
    for (const field of value.state === "unknown"
      ? ["registration_id"]
      : ["registration_id", "member_id", "incarnation_id"]) {
      invalid.push({
        name: `${value.state} mismatched ${field}`,
        body: JSON.stringify({
          ...value,
          [field]: field === "member_id" ? "acp-other" : otherUuid,
        }),
      });
    }
  }
  for (const field of Object.keys(stopped.stop_receipt)) {
    const receipt: Record<string, unknown> = { ...stopped.stop_receipt };
    delete receipt[field];
    invalid.push({
      name: `receipt missing ${field}`,
      body: JSON.stringify({ ...stopped, stop_receipt: receipt }),
    });
  }
  for (const timestamp of [
    "2026-02-30T12:34:56Z",
    "2026-10-23T24:00:00Z",
    "2026-10-23T12:34:56.1234567890Z",
    "2026-10-23T12:34:56+00:00",
    observedAt + "\n",
  ]) {
    invalid.push({
      name: `invalid running timestamp ${JSON.stringify(timestamp)}`,
      body: JSON.stringify({ ...running, observed_at: timestamp }),
    });
    invalid.push({
      name: `invalid receipt timestamp ${JSON.stringify(timestamp)}`,
      body: JSON.stringify({
        ...stopped,
        stop_receipt: { ...stopped.stop_receipt, observed_at: timestamp },
      }),
    });
  }
  it.each(invalid)(
    "rejects $name as unavailable without synthesizing a stop or retrying",
    async ({ body, media }) => {
      await withInspectionPeer(
        ({ response }) => {
          if (media === null) response.removeHeader("Content-Type");
          else if (media !== undefined)
            response.setHeader("Content-Type", media);
          response.end(body);
        },
        async (peer) => {
          expectFailure(
            await deadline(peer.start().promise),
            "acp_registry_unavailable",
            peer,
          );
          expect(peer.calls).toHaveLength(1);
          expect(peer.authentication.flights).toHaveLength(1);
          expectBodiesJoined(peer.authentication);
        },
      );
    },
  );

  it.each([201, 204, 401, 403, 404, 503])(
    "does not accept an otherwise valid stop DTO on HTTP %i",
    async (status) => {
      await withInspectionPeer(
        ({ response }) => {
          response.statusCode = status;
          response.end(JSON.stringify(stopped));
        },
        async (peer) => {
          expectFailure(
            await deadline(peer.start().promise),
            "acp_registry_unavailable",
            peer,
          );
          expect(peer.calls).toHaveLength(1);
          expect(peer.authentication.flights).toHaveLength(1);
          expectBodiesJoined(peer.authentication);
        },
      );
    },
  );

  it("does not expose an HTTP peer's private error body or cause", async () => {
    await withInspectionPeer(
      ({ response }, token) => {
        response.statusCode = 503;
        response.end(
          JSON.stringify({
            code: privateCause,
            message: token,
            retryable: true,
          }),
        );
      },
      async (peer) => {
        expectFailure(
          await deadline(peer.start().promise),
          "acp_registry_unavailable",
          peer,
        );
        expect(peer.calls).toHaveLength(1);
        expectBodiesJoined(peer.authentication);
      },
    );
  });

  it("rejects malformed UTF-8 bytes and joins the original response", async () => {
    await withInspectionPeer(
      ({ response }) => {
        const body = JSON.stringify(stopped);
        const index = body.indexOf(registration.member_id);
        response.end(
          Buffer.concat([
            Buffer.from(body.slice(0, index)),
            Buffer.from([0xc3, 0x28]),
            Buffer.from(body.slice(index + registration.member_id.length)),
          ]),
        );
      },
      async (peer) => {
        expectFailure(
          await deadline(peer.start().promise),
          "acp_registry_unavailable",
          peer,
        );
        expect(peer.calls).toHaveLength(1);
        expectBodiesJoined(peer.authentication);
      },
    );
  });

  it("does not follow a redirect even when its target returns a valid stop proof", async () => {
    await withInspectionPeer(
      ({ response }) => {
        response.end(JSON.stringify(stopped));
      },
      async (target) => {
        await withInspectionPeer(
          ({ response }) => {
            response.writeHead(307, {
              Location: `${target.origin}/private-inspection`,
            });
            response.end();
          },
          async (source) => {
            expectFailure(
              await deadline(source.start().promise),
              "acp_registry_unavailable",
              source,
              target.origin,
            );
            expect(source.calls).toHaveLength(1);
            expect(source.authentication.flights).toHaveLength(1);
            expect(target.calls).toHaveLength(0);
          },
        );
      },
    );
  });

  it.each([false, true])(
    "accepts an exact 8192-byte complete body, declared=%s",
    async (declared) => {
      const reply = JSON.stringify(stopped);
      const body = reply + " ".repeat(8192 - Buffer.byteLength(reply));
      await withInspectionPeer(
        ({ response }) => {
          if (declared) response.setHeader("Content-Length", "8192");
          response.write(body);
          response.end();
        },
        async (peer) => {
          expectInspection(await deadline(peer.start().promise), stopped);
          expect(peer.calls).toHaveLength(1);
          expectBodiesJoined(peer.authentication);
        },
      );
    },
  );

  it.each([false, true])(
    "cancels and joins an unfinished 8193-byte response, declared=%s",
    async (declared) => {
      const reply = JSON.stringify(stopped);
      await withInspectionPeer(
        async (call) => {
          if (declared) call.response.setHeader("Content-Length", "8293");
          call.response.write(
            reply + " ".repeat(8193 - Buffer.byteLength(reply)),
          );
          call.response.flushHeaders();
          await call.socketClosed;
        },
        async (peer) => {
          const pending = peer.start();
          const call = await deadline(peer.firstCall);
          expectFailure(
            await deadline(pending.promise),
            "acp_registry_unavailable",
            peer,
          );
          await deadline(call.socketClosed);
          await deadline(call.finished);
          expect(peer.socketCount()).toBe(0);
          expect(peer.calls).toHaveLength(1);
          expectBodiesJoined(peer.authentication);
        },
      );
    },
  );

  it("rejects a pre-cancelled inspection without opening a request", async () => {
    await withInspectionPeer(
      ({ response }) => {
        response.end(JSON.stringify(stopped));
      },
      async (peer) => {
        const controller = new AbortController();
        controller.abort(new Error(privateCause));
        expectFailure(
          await deadline(peer.start(registration, controller.signal).promise),
          "deadline_exceeded",
          peer,
        );
        expect(peer.calls).toHaveLength(0);
        expect(peer.authentication.flights).toHaveLength(0);
      },
    );
  });

  it.each([
    { name: "null", value: null },
    {
      name: "missing binding",
      value: { registration_id: registration.registration_id },
    },
    {
      name: "extra selector",
      value: { ...registration, selector: privateCause },
    },
    {
      name: "noncanonical registration",
      value: {
        ...registration,
        registration_id: registration.registration_id.toUpperCase(),
      },
    },
    {
      name: "noncanonical incarnation",
      value: {
        ...registration,
        incarnation_id: registration.incarnation_id.toUpperCase(),
      },
    },
    {
      name: "path injection",
      value: { ...registration, registration_id: "../../private" },
    },
    {
      name: "invalid member",
      value: { ...registration, member_id: "acp.other" },
    },
  ])(
    "rejects $name expected identity before any network work",
    async ({ value }) => {
      await withInspectionPeer(
        ({ response }) => {
          response.end(JSON.stringify(stopped));
        },
        async (peer) => {
          expectFailure(
            await deadline(peer.start(value).promise),
            "acp_registry_unavailable",
            peer,
          );
          expect(peer.calls).toHaveLength(0);
          expect(peer.authentication.flights).toHaveLength(0);
        },
      );
    },
  );

  it("snapshots the expected binding before a caller mutates it during held HTTP work", async () => {
    const release = Promise.withResolvers<void>();
    await withInspectionPeer(
      async ({ response }) => {
        await release.promise;
        response.end(JSON.stringify(running));
      },
      async (peer) => {
        const expected = structuredClone(registration);
        const pending = peer.start(expected);
        try {
          const call = await deadline(peer.firstCall);
          expected.registration_id = otherUuid;
          expected.member_id = "acp-other";
          expected.incarnation_id = otherUuid;
          release.resolve();
          expectInspection(await deadline(pending.promise), running);
          expect(call.path).toBe(
            `/internal/acp-incarnations/${registration.registration_id}`,
          );
          expect(expected).toEqual({
            registration_id: otherUuid,
            member_id: "acp-other",
            incarnation_id: otherUuid,
          });
          expect(peer.calls).toHaveLength(1);
          expectBodiesJoined(peer.authentication);
        } finally {
          release.resolve();
          await pending.promise;
        }
      },
    );
  });

  for (const stage of ["headers", "partial-body"] as const) {
    it(`joins original ${stage} work and closes the actual socket after parent cancellation`, async () => {
      await withInspectionPeer(
        async (call) => {
          if (stage === "partial-body") {
            call.response.write('{"state":"stopped",');
            call.response.flushHeaders();
          }
          await call.socketClosed;
        },
        async (peer) => {
          const controller = new AbortController();
          const pending = peer.start(registration, controller.signal);
          const call = await deadline(peer.firstCall);
          if (stage === "partial-body") {
            const body = await deadline(peer.authentication.firstRead.promise);
            await vi.waitFor(
              () => expect(body.reads.some((read) => !read.settled)).toBe(true),
              { timeout: 1000 },
            );
          }
          controller.abort(new Error(`${privateCause}:${peer.token}`));
          expectFailure(
            await deadline(pending.promise),
            "deadline_exceeded",
            peer,
          );
          await deadline(call.socketClosed);
          await deadline(call.finished);
          expect(pending.settled).toBe(true);
          expect(peer.socketCount()).toBe(0);
          expect(peer.calls).toHaveLength(1);
          expectBodiesJoined(peer.authentication);
        },
      );
    });

    it(`bounds original ${stage} work by the shortened total request budget`, async () => {
      await withInspectionPeer(
        async (call) => {
          if (stage === "partial-body") {
            call.response.write('{"state":"stopped",');
            call.response.flushHeaders();
          }
          await call.socketClosed;
        },
        async (peer) => {
          const pending = peer.start();
          const call = await deadline(peer.firstCall);
          if (stage === "partial-body")
            await deadline(peer.authentication.firstRead.promise);
          expectFailure(
            await deadline(pending.promise),
            "deadline_exceeded",
            peer,
          );
          await deadline(call.socketClosed);
          await deadline(call.finished);
          expect(peer.socketCount()).toBe(0);
          expect(peer.calls).toHaveLength(1);
          expectBodiesJoined(peer.authentication);
        },
        200,
      );
    });
  }

  it.each([
    {
      name: "valid stop body",
      status: 200,
      cleanupFailure: false,
      code: "deadline_exceeded" as const,
    },
    {
      name: "definite 404",
      status: 404,
      cleanupFailure: false,
      code: "acp_registry_unavailable" as const,
    },
    {
      name: "independent cleanup failure",
      status: 200,
      cleanupFailure: true,
      code: "acp_registry_unavailable" as const,
    },
  ])(
    "keeps $name private and joins held original cancellation before applying parent abort",
    async ({ status, cleanupFailure, code }) => {
      await withInspectionPeer(
        ({ response }) => {
          response.statusCode = status;
          response.end(JSON.stringify(stopped));
        },
        async (peer) => {
          const controller = new AbortController();
          const entered = Promise.withResolvers<void>(),
            release = Promise.withResolvers<void>();
          peer.authentication.releaseHeldCleanup = () => release.resolve();
          peer.authentication.afterCancellation = async () => {
            entered.resolve();
            await release.promise;
            if (cleanupFailure)
              throw new Error(`${privateCause}:${peer.token}:${peer.origin}`);
          };
          const pending = peer.start(registration, controller.signal);
          try {
            const call = await deadline(peer.firstCall);
            await deadline(entered.promise);
            await deadline(call.socketClosed);
            await deadline(call.finished);
            const body = peer.authentication.bodies[0];
            if (body === undefined)
              throw new Error("missing original inspection reader");
            expect(body.closed.settled).toBe(true);
            expect(body.cancels.length).toBeGreaterThan(0);
            expect(body.cancels.every((cancel) => cancel.settled)).toBe(true);
            expect(
              pending.settled,
              "inspection returned before original cancellation cleanup joined",
            ).toBe(false);
            controller.abort(new Error(privateCause));
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(
              pending.settled,
              "parent abort bypassed original cleanup",
            ).toBe(false);
            expect(body.response.body?.locked).toBe(true);
            release.resolve();
            expectFailure(await deadline(pending.promise), code, peer);
            expect(peer.socketCount()).toBe(0);
            expect(peer.calls).toHaveLength(1);
            expectBodiesJoined(peer.authentication);
          } finally {
            controller.abort(new Error("inspection fixture cleanup"));
            release.resolve();
            await pending.promise;
          }
        },
      );
    },
  );
});

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
type Observed<T> = { readonly settled: boolean; promise: Promise<Outcome<T>> };
type BodyObservation = {
  response: Response;
  closed: Observed<void>;
  reads: Array<Observed<ReadableStreamReadResult<Uint8Array>>>;
  cancels: Array<Observed<void>>;
  cancelCompletions: Array<Observed<void>>;
  released: boolean;
};
type PeerCall = {
  method: string | undefined;
  path: string | undefined;
  headers: IncomingHttpHeaders;
  body: Buffer;
  response: ServerResponse;
  socketClosed: Promise<void>;
  finished: Promise<void>;
};
type Peer = {
  origin: string;
  token: string;
  authentication: InspectionAuthentication;
  calls: PeerCall[];
  firstCall: Promise<PeerCall>;
  start(expected?: unknown, signal?: AbortSignal): Observed<Inspection>;
  socketCount(): number;
};

function observe<T>(original: Promise<T>): Observed<T> {
  const state = { settled: false };
  const promise = original.then<Outcome<T>, Outcome<T>>(
    (value) => {
      state.settled = true;
      return { ok: true, value };
    },
    (error: unknown) => {
      state.settled = true;
      return { ok: false, error };
    },
  );
  return {
    promise,
    get settled() {
      return state.settled;
    },
  };
}

// Keep the real authenticated fetch, response and reader. Receipts observe the
// original read/cancel/closed Promises; the one explicit gate delays only the
// returned cancellation receipt after the original cancel and close have joined.
class InspectionAuthentication extends ServiceAuthentication {
  public readonly flights: Array<Observed<Response>> = [];
  public readonly responses: Response[] = [];
  public readonly bodies: BodyObservation[] = [];
  public readonly firstRead = Promise.withResolvers<BodyObservation>();
  public afterCancellation: (() => Promise<void>) | undefined;
  public releaseHeldCleanup: (() => void) | undefined;
  private readonly restores: Array<() => void> = [];

  public override fetchFor(receiver: string, origin: string): typeof fetch {
    const send = super.fetchFor(receiver, origin);
    return (input, init) => {
      const actual = send(input, init);
      this.flights.push(
        observe(
          actual.then((response) => {
            this.responses.push(response);
            this.observeBody(response);
            return response;
          }),
        ),
      );
      return actual;
    };
  }

  public restore(): void {
    for (const restore of this.restores.reverse()) restore();
    this.restores.length = 0;
  }

  private replace(target: object, key: string, value: unknown): void {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    this.restores.push(() => {
      if (descriptor === undefined) Reflect.deleteProperty(target, key);
      else Object.defineProperty(target, key, descriptor);
    });
    Object.defineProperty(target, key, { configurable: true, value });
  }

  private observeBody(response: Response): void {
    const body = response.body;
    if (body === null) return;
    const getReader = body.getReader.bind(body);
    this.replace(body, "getReader", () => {
      const reader = getReader();
      const record: BodyObservation = {
        response,
        closed: observe(reader.closed),
        reads: [],
        cancels: [],
        cancelCompletions: [],
        released: false,
      };
      this.bodies.push(record);
      const read = reader.read.bind(reader);
      this.replace(reader, "read", () => {
        const actual = read();
        record.reads.push(observe(actual));
        this.firstRead.resolve(record);
        return actual;
      });
      const cancel = reader.cancel.bind(reader);
      this.replace(reader, "cancel", (reason?: unknown): Promise<void> => {
        const actual = cancel(reason);
        const cancelled = observe(actual);
        record.cancels.push(cancelled);
        const after = this.afterCancellation;
        if (after === undefined) return actual;
        const completion = (async () => {
          const original = await cancelled.promise;
          await record.closed.promise;
          await after();
          if (!original.ok) throw original.error;
        })();
        record.cancelCompletions.push(observe(completion));
        return completion;
      });
      const release = reader.releaseLock.bind(reader);
      this.replace(reader, "releaseLock", () => {
        release();
        record.released = true;
      });
      return reader;
    });
  }
}

async function withInspectionPeer(
  respond: (call: PeerCall, token: string) => void | Promise<void>,
  work: (peer: Peer) => Promise<void>,
  timeoutMs?: number,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "antnest-owner-inspection-"));
  const token = randomBytes(32).toString("base64url");
  const failures: unknown[] = [];
  const pending: Array<Observed<Inspection>> = [];
  const controllers: AbortController[] = [];
  const handlers: Promise<void>[] = [];
  const closedSockets: Promise<void>[] = [];
  const sockets = new Set<Socket>();
  const calls: PeerCall[] = [];
  const firstCall = Promise.withResolvers<PeerCall>();
  let authentication: InspectionAuthentication | undefined;
  let listening = false;
  const server = createServer((incoming, response) => {
    const finished = Promise.withResolvers<void>();
    const socketClosed = new Promise<void>((resolve) =>
      incoming.socket.once("close", () => resolve()),
    );
    const task = (async () => {
      try {
        const body = await readRequest(incoming);
        const call: PeerCall = {
          method: incoming.method,
          path: incoming.url,
          headers: { ...incoming.headers },
          body,
          response,
          socketClosed,
          finished: finished.promise,
        };
        calls.push(call);
        firstCall.resolve(call);
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Connection", "close");
        await respond(call, token);
      } finally {
        finished.resolve();
      }
    })().catch(() => {
      failures.push(new Error("inspection HTTP fixture handler failed"));
      response.destroy();
    });
    handlers.push(task);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    closedSockets.push(
      new Promise<void>((resolve) => {
        socket.once("close", () => {
          sockets.delete(socket);
          resolve();
        });
      }),
    );
  });
  const attempt = async (
    action: () => Promise<unknown> | void,
  ): Promise<void> => {
    try {
      await action();
    } catch (error: unknown) {
      failures.push(error);
    }
  };
  try {
    const callersPath = join(directory, "callers.json");
    writeFileSync(callersPath, "{}", { mode: 0o600 });
    writeFileSync(join(directory, "runtime-controller"), token, {
      mode: 0o600,
    });
    authentication = new InspectionAuthentication({
      ANTNEST_SERVICE_AUTH_MODE: "token",
      ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT: "true",
      ANTNEST_SERVICE_AUTH_CALLERS_FILE: callersPath,
      ANTNEST_SERVICE_AUTH_TOKEN_DIR: directory,
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    listening = true;
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("missing inspection fixture address");
    const origin = `http://127.0.0.1:${address.port}`;
    const client = new RuntimeControllerIncarnations({
      origin,
      authentication,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    await work({
      origin,
      token,
      authentication,
      calls,
      firstCall: firstCall.promise,
      socketCount: () => sockets.size,
      start(expected = registration, signal) {
        const controller = new AbortController();
        controllers.push(controller);
        const actual = (async () =>
          client.inspect(
            expected as OwnerRegistration,
            signal === undefined
              ? controller.signal
              : AbortSignal.any([signal, controller.signal]),
          ))();
        const operation = observe(actual);
        pending.push(operation);
        return operation;
      },
    });
  } catch (error: unknown) {
    failures.push(error);
  } finally {
    authentication?.releaseHeldCleanup?.();
    for (const controller of controllers)
      controller.abort(new Error("inspection fixture cleanup"));
    const closing = listening
      ? observe(
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
        )
      : undefined;
    // Behavioral socket assertions precede this fallback. It cannot turn an
    // unjoined original inspection, reader or handler into a passing assertion.
    server.closeAllConnections();
    await attempt(() =>
      Promise.all(pending.map((operation) => operation.promise)),
    );
    await attempt(() => Promise.all(handlers));
    await attempt(() => Promise.all(closedSockets));
    if (closing !== undefined)
      await attempt(async () => {
        const result = await closing.promise;
        if (!result.ok) throw result.error;
      });
    if (authentication !== undefined) {
      const original = authentication;
      await attempt(() =>
        Promise.all(original.flights.map((flight) => flight.promise)),
      );
      await attempt(async () => {
        for (const body of original.bodies) {
          await body.closed.promise;
          await Promise.all(body.reads.map((read) => read.promise));
          await Promise.all(body.cancels.map((cancel) => cancel.promise));
          await Promise.all(
            body.cancelCompletions.map((cancel) => cancel.promise),
          );
        }
      });
      await attempt(() => original.close());
      await attempt(() => expectBodiesJoined(original));
      await attempt(() => original.restore());
    }
    await attempt(() => {
      expect(sockets.size, "inspection fixture retained a real socket").toBe(0);
      expect(
        pending.every((operation) => operation.settled),
        "inspection fixture abandoned an original call",
      ).toBe(true);
    });
    await attempt(() => rmSync(directory, { recursive: true, force: true }));
  }
  if (failures.length === 1 && failures[0] instanceof Error) throw failures[0];
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      "inspection business and cleanup failures",
    );
}

async function readRequest(incoming: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of incoming as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > 4096)
      throw new Error("inspection request exceeded its fixture wire bound");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function expectInspection(
  outcome: Outcome<Inspection>,
  expected: Inspection,
): void {
  expect(outcome.ok, "inspection did not retain the complete wire DTO").toBe(
    true,
  );
  if (!outcome.ok) throw new Error("inspection unexpectedly failed");
  expect(
    isDeepStrictEqual(outcome.value, expected),
    "inspection changed, projected or synthesized its result",
  ).toBe(true);
}

function expectFailure(
  outcome: Outcome<Inspection>,
  code: "acp_registry_unavailable" | "deadline_exceeded",
  peer: Peer,
  ...privateValues: string[]
): void {
  expect(outcome.ok, "unavailable inspection became a stop proof").toBe(false);
  if (outcome.ok) throw new Error("inspection unexpectedly succeeded");
  expect(
    outcome.error instanceof OwnerIncarnationError,
    "inspection lost its fixed private error type",
  ).toBe(true);
  if (!(outcome.error instanceof OwnerIncarnationError))
    throw new Error("inspection returned an untyped error");
  expect(outcome.error.code).toBe(code);
  expect(outcome.error.message).toBe(code);
  expect(
    outcome.error.cause,
    "inspection retained a raw dependency cause",
  ).toBeUndefined();
  const rendered = inspect(outcome.error, { depth: 8 });
  expect(
    [privateCause, peer.token, peer.origin, ...privateValues].every(
      (value) => !rendered.includes(value),
    ),
    "inspection error disclosed private peer material",
  ).toBe(true);
}

function expectBodiesJoined(authentication: InspectionAuthentication): void {
  expect(
    authentication.flights.every((flight) => flight.settled),
    "inspection abandoned its original fetch",
  ).toBe(true);
  expect(
    authentication.responses.every(
      (response) =>
        response.body === null || (response.bodyUsed && !response.body.locked),
    ),
    "inspection retained an unread or locked original body",
  ).toBe(true);
  for (const body of authentication.bodies) {
    expect(body.closed.settled, "inspection did not join reader.closed").toBe(
      true,
    );
    expect(
      body.reads.every((read) => read.settled),
      "inspection abandoned an original read",
    ).toBe(true);
    expect(
      body.cancels.every((cancel) => cancel.settled),
      "inspection abandoned original cancellation",
    ).toBe(true);
    expect(
      body.cancelCompletions.every((cancel) => cancel.settled),
      "inspection abandoned cancellation cleanup",
    ).toBe(true);
    expect(
      body.released,
      "inspection did not release its original reader",
    ).toBe(true);
  }
}

// A failed observation does not abandon the watched Promise: fixture finally
// aborts, releases held cleanup, closes actual sockets and joins every original.
async function deadline<T>(original: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("inspection HTTP observation timed out")),
        3000,
      );
      original.then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
  }
}
