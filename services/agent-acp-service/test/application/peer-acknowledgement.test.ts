import { describe, expect, it, vi } from "vitest";
import {
  PeerAcknowledgement,
  type PeerAcknowledgementOptions,
} from "../../src/application/peer-acknowledgement.js";
import type { executionPublication } from "../../src/domain/execution-publication.js";
import { publicExecutionConfiguration } from "../../src/domain/execution-configuration.js";
import { executionConfiguration } from "../fixtures/execution-configuration.js";

const registration = (member = "acp-a", digit = "1") => ({
  registration_id: `${digit.repeat(8)}-1111-4111-8111-111111111111`,
  member_id: member,
  incarnation_id: `${digit.repeat(8)}-2222-4222-8222-222222222222`,
});

function setup() {
  const authority = executionConfiguration();
  authority.agents.push({ ...structuredClone(authority.agents[0]!), agent_id: "agent-b" });
  const captured = {
    authority,
    configuration: publicExecutionConfiguration(authority),
    assertCurrent: vi.fn(),
  };
  const source = registration();
  const peer = registration("acp-b", "2");
  const oldHolder = registration("acp-old", "3");
  const digest = "a".repeat(64);
  const receipt = (
    request: {
      request_id: string;
      membership_sha256: string;
      publication: ReturnType<typeof executionPublication>;
    },
    target = peer,
  ) => ({
    request_id: request.request_id,
    membership_sha256: request.membership_sha256,
    publication: request.publication,
    registration: target,
    status: "applied" as const,
    revocation: "joined" as const,
    owned_agents:
      target.member_id === "acp-old"
        ? []
        : [{ agent_id: target.member_id === "acp-a" ? "agent-1" : "agent-b", epoch: "1" }],
  });
  const identify = vi.fn(
    (
      member: string,
      request: { request_id: string; membership_sha256: string; challenge: string },
    ) =>
      Promise.resolve({
        request_id: request.request_id,
        membership_sha256: request.membership_sha256,
        challenge: request.challenge,
        registration: member === "acp-old" ? oldHolder : peer,
      }),
  );
  const publish = vi.fn(
    (_member: string, request: Parameters<typeof receipt>[0] & { target: typeof peer }) =>
      Promise.resolve(receipt(request, request.target)),
  );
  const local = vi.fn<PeerAcknowledgementOptions["local"]>((_capture, request) =>
    Promise.resolve(receipt(request, source)),
  );
  const confirm = vi.fn<PeerAcknowledgementOptions["confirm"]>(() => Promise.resolve());
  const coordinator = new PeerAcknowledgement({
    registration: source,
    membershipSha256: digest,
    members: ["acp-a", "acp-b", "acp-old"],
    peers: { identify, publish },
    local,
    confirm,
  });
  return {
    coordinator,
    captured,
    source,
    peer,
    receipt,
    identify,
    publish,
    local,
    confirm,
    run: () =>
      coordinator.confirm(captured, new Date(Date.now() + 5000), new AbortController().signal),
  };
}

describe("complete peer publication acknowledgement", () => {
  it("covers the stopped member separately and confirms the survivor's complete fences under the captured participation version", async () => {
    const f = setup();
    const guard = { membershipSha256: "a".repeat(64), revision: "2" };
    const identify = vi.fn(() => Promise.reject(new Error("dead peer must not be contacted")));
    const publish = vi.fn(() => Promise.reject(new Error("dead peer must not be contacted")));
    const local = vi.fn<PeerAcknowledgementOptions["local"]>((_capture, request) =>
      Promise.resolve({
        ...f.receipt(request, f.source),
        owned_agents: [
          { agent_id: "agent-1", epoch: "2" },
          { agent_id: "agent-b", epoch: "2" },
        ],
      }),
    );
    const availability = {
      refresh: vi.fn(() =>
        Promise.resolve({
          guard,
          members: [
            { memberId: "acp-a", state: "running" as const, registration: f.source, stopped: [] },
            {
              memberId: "acp-b",
              state: "stopped" as const,
              stopped: [
                {
                  ...f.peer,
                  state: "stopped" as const,
                  stop_receipt: {
                    receipt_id: "33333333-3333-4333-8333-333333333333",
                    reason: "container_stopped" as const,
                    observed_at: "2026-10-24T00:00:00Z",
                  },
                },
              ],
            },
          ],
          live: [f.source],
        }),
      ),
    };
    const coordinator = new PeerAcknowledgement({
      registration: f.source,
      membershipSha256: guard.membershipSha256,
      members: ["acp-a", "acp-b"],
      peers: { identify, publish },
      local,
      confirm: f.confirm,
      availability,
    });
    await coordinator.confirm(
      f.captured,
      new Date(Date.now() + 5000),
      new AbortController().signal,
    );
    expect(availability.refresh).toHaveBeenCalledOnce();
    expect(identify).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(f.confirm.mock.calls[0]?.[2]).toMatchObject({ participation: guard });
    expect(f.confirm.mock.calls[0]?.[1]).toHaveLength(2);
    expect(local).toHaveBeenCalledOnce();
  });

  it("collects both owners and the nonowner before one complete final database confirmation", async () => {
    const f = setup();
    await f.run();
    expect(f.identify.mock.calls.map(([member]) => member)).toEqual(["acp-b", "acp-old"]);
    expect(f.local).toHaveBeenCalledOnce();
    expect(f.confirm).toHaveBeenCalledOnce();
    expect(f.confirm).toHaveBeenCalledWith(
      f.captured.authority,
      [
        {
          organizationId: "organization-1",
          agentId: "agent-1",
          ownerInstanceId: f.source.incarnation_id,
          epoch: "1",
        },
        {
          organizationId: "organization-1",
          agentId: "agent-b",
          ownerInstanceId: f.peer.incarnation_id,
          epoch: "1",
        },
      ],
      expect.anything(),
    );
    expect(f.confirm.mock.calls[0]?.[2].timeoutMs).toBeGreaterThan(0);
    expect(f.confirm.mock.calls[0]?.[2].timeoutMs).toBeLessThanOrEqual(5000);
    expect(f.captured.assertCurrent).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "unknown owner",
      (value: ReturnType<ReturnType<typeof setup>["receipt"]>) => {
        value.owned_agents[0]!.agent_id = "unknown";
      },
    ],
    [
      "duplicate owner",
      (value: ReturnType<ReturnType<typeof setup>["receipt"]>) => {
        value.owned_agents[0]!.agent_id = "agent-1";
      },
    ],
    [
      "missing owner",
      (value: ReturnType<ReturnType<typeof setup>["receipt"]>) => {
        value.owned_agents = [];
      },
    ],
    [
      "stale process",
      (value: ReturnType<ReturnType<typeof setup>["receipt"]>) => {
        value.registration = registration("acp-b", "4");
      },
    ],
    [
      "different authority",
      (value: ReturnType<ReturnType<typeof setup>["receipt"]>) => {
        value.publication = { ...value.publication, authority_sha256: "b".repeat(64) };
      },
    ],
    [
      "wrong membership",
      (value: ReturnType<ReturnType<typeof setup>["receipt"]>) => {
        value.membership_sha256 = "b".repeat(64);
      },
    ],
    [
      "wrong request",
      (value: ReturnType<ReturnType<typeof setup>["receipt"]>) => {
        value.request_id = "77777777-7777-4777-8777-777777777777";
      },
    ],
    [
      "overflow epoch",
      (value: ReturnType<ReturnType<typeof setup>["receipt"]>) => {
        value.owned_agents[0]!.epoch = "9223372036854775808";
      },
    ],
    [
      "epoch with trailing LF",
      (value: ReturnType<ReturnType<typeof setup>["receipt"]>) => {
        value.owned_agents[0]!.epoch = "1\n";
      },
    ],
    [
      "epoch with trailing CRLF",
      (value: ReturnType<ReturnType<typeof setup>["receipt"]>) => {
        value.owned_agents[0]!.epoch = "1\r\n";
      },
    ],
  ] as const)("rejects %s receipts before final SQL", async (_name, edit) => {
    const f = setup();
    f.publish.mockImplementationOnce((_member, request) => {
      const value = f.receipt(request);
      edit(value);
      return Promise.resolve(value);
    });
    await expect(f.run()).rejects.toMatchObject({ code: "configuration_unavailable" });
    expect(f.confirm).not.toHaveBeenCalled();
  });

  it("does not omit a nonowner whose old-stream cleanup is still held", async () => {
    const f = setup();
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    let complete = false;
    f.publish.mockImplementation(async (member, request) => {
      if (member === "acp-old") {
        entered.resolve();
        await released.promise;
      }
      return f.receipt(request, request.target);
    });
    const original = f.run().then(() => {
      complete = true;
    });
    try {
      await entered.promise;
      expect(complete).toBe(false);
      expect(f.confirm).not.toHaveBeenCalled();
      released.resolve();
      await original;
      expect(f.confirm).toHaveBeenCalledOnce();
    } finally {
      released.resolve();
      await Promise.allSettled([original]);
    }
  });

  it("rejects a peer identity response to a different challenge without publication", async () => {
    const f = setup();
    f.identify.mockImplementationOnce((_member, request) =>
      Promise.resolve({
        request_id: request.request_id,
        membership_sha256: request.membership_sha256,
        challenge: "b".repeat(64),
        registration: f.peer,
      }),
    );
    await expect(f.run()).rejects.toMatchObject({ code: "configuration_unavailable" });
    expect(f.publish.mock.calls.some(([member]) => member === "acp-b")).toBe(false);
    expect(f.confirm).not.toHaveBeenCalled();
  });

  it("keeps the expected authority for the final transaction and propagates its rejection", async () => {
    const f = setup();
    const failure = new Error("lease takeover or sealed DB authority changed");
    f.confirm.mockRejectedValue(failure);
    await expect(f.run()).rejects.toBe(failure);
    expect(f.confirm.mock.calls[0]?.[0]).toBe(f.captured.authority);
  });

  it("rejects local supersession after remote receipts without final SQL", async () => {
    const f = setup();
    f.publish.mockImplementationOnce((_member, request) => {
      f.captured.assertCurrent.mockImplementationOnce(() => {
        throw new Error("superseded");
      });
      return Promise.resolve(f.receipt(request));
    });
    await expect(f.run()).rejects.toThrow("superseded");
    expect(f.confirm).not.toHaveBeenCalled();
  });

  it("joins every original peer operation after cancellation before releasing its owner", async () => {
    const f = setup();
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const controller = new AbortController();
    let complete = false;
    f.publish.mockImplementationOnce(async (_member, request) => {
      entered.resolve();
      await released.promise;
      return f.receipt(request);
    });
    const original = f.coordinator.confirm(
      f.captured,
      new Date(Date.now() + 5000),
      controller.signal,
    );
    void original.then(
      () => {
        complete = true;
      },
      () => {
        complete = true;
      },
    );
    try {
      await entered.promise;
      const reason = new Error("caller closed");
      controller.abort(reason);
      await Promise.resolve();
      expect(complete).toBe(false);
      released.resolve();
      await expect(original).rejects.toBe(reason);
      expect(f.confirm).not.toHaveBeenCalled();
    } finally {
      released.resolve();
      await Promise.allSettled([original]);
    }
  });

  it("joins the original final SQL after cancellation and refuses its late success", async () => {
    const f = setup();
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const controller = new AbortController();
    const reason = new Error("request cancelled during final SQL");
    let complete = false;
    f.confirm.mockImplementationOnce(async () => {
      entered.resolve();
      await released.promise;
    });
    const original = f.coordinator.confirm(
      f.captured,
      new Date(Date.now() + 5000),
      controller.signal,
    );
    void original.then(
      () => {
        complete = true;
      },
      () => {
        complete = true;
      },
    );
    try {
      await entered.promise;
      controller.abort(reason);
      await Promise.resolve();
      expect(complete).toBe(false);
      released.resolve();
      await expect(original).rejects.toBe(reason);
    } finally {
      released.resolve();
      await Promise.allSettled([original]);
    }
  });

  it("rejects a publication replaced while final SQL was in flight", async () => {
    const f = setup();
    const reason = new Error("publication replaced after final confirmation began");
    f.confirm.mockImplementationOnce(() => {
      f.captured.assertCurrent.mockImplementationOnce(() => {
        throw reason;
      });
      return Promise.resolve();
    });
    await expect(f.run()).rejects.toBe(reason);
    expect(f.confirm).toHaveBeenCalledOnce();
    expect(f.captured.assertCurrent).toHaveBeenCalledTimes(2);
  });
  it("reports an expired aggregate through the public configuration error while retaining the private deadline cause", async () => {
    const f = setup();
    await expect(
      f.coordinator.confirm(f.captured, new Date(Date.now() - 1), new AbortController().signal),
    ).rejects.toMatchObject({
      code: "configuration_unavailable",
      cause: { code: "deadline_exceeded" },
    });
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.identify).not.toHaveBeenCalled();
  });
});
