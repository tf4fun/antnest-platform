import { describe, expect, it } from "vitest";
import { ConnectionCapacity } from "../../src/application/connection-capacity.js";
import { DomainError } from "../../src/domain/errors.js";

const identity = (organizationId = "organization-1", principalId = "principal-1") => ({
  organizationId,
  principalId,
});
const rejected = (operation: () => unknown) => {
  expect(operation).toThrow(
    expect.objectContaining({
      name: "DomainError",
      code: "connection_quota_exceeded",
      errorClass: "resource",
      message: "Connection capacity is exhausted",
      retryable: true,
      retryAfterMs: 1000,
      recovery: "backoff",
    }),
  );
};

describe("connection capacity ownership", () => {
  it("enforces the principal limit without charging rejected attempts to the organization or process", () => {
    const capacity = new ConnectionCapacity({ global: 4, organization: 2, principal: 1 });
    const first = capacity.reserve(identity());
    for (let i = 0; i < 100; i++) rejected(() => capacity.reserve(identity()));
    const second = capacity.reserve(identity("organization-1", "principal-2"));
    rejected(() => capacity.reserve(identity("organization-1", "principal-3")));
    const other = capacity.reserve(identity("organization-2"));
    const last = capacity.reserve(identity("organization-2", "principal-2"));
    rejected(() => capacity.reserve(identity("organization-3")));
    for (const lease of [first, second, other, last]) lease.release();
    expect(() => capacity.reserve(identity())).not.toThrow();
  });

  it("scopes the same principal by organization while sharing each organization's limit", () => {
    const capacity = new ConnectionCapacity({ global: 6, organization: 2, principal: 1 });
    const one = capacity.reserve(identity("organization-1", "same-principal"));
    const two = capacity.reserve(identity("organization-2", "same-principal"));
    rejected(() => capacity.reserve(identity("organization-1", "same-principal")));
    rejected(() => capacity.reserve(identity("organization-2", "same-principal")));
    one.release();
    expect(() => capacity.reserve(identity("organization-1", "same-principal"))).not.toThrow();
    rejected(() => capacity.reserve(identity("organization-2", "same-principal")));
    two.release();
  });

  it("counts held ownership until explicit release and ignores stale duplicate releases", () => {
    const capacity = new ConnectionCapacity({ global: 1, organization: 1, principal: 1 });
    const old = capacity.reserve(identity());
    rejected(() => capacity.reserve(identity("organization-2")));
    old.release();
    const replacement = capacity.reserve(identity());
    old.release();
    old.release();
    rejected(() => capacity.reserve(identity()));
    replacement.release();
    const third = capacity.reserve(identity("organization-3"));
    rejected(() => capacity.reserve(identity()));
    third.release();
  });

  it("can retire and replace distinct tenant/principal buckets without retaining capacity", () => {
    const capacity = new ConnectionCapacity({ global: 1, organization: 1, principal: 1 });
    for (let i = 0; i < 1000; i++) {
      const lease = capacity.reserve(identity(`org-${i}`, `principal-${i}`));
      rejected(() => capacity.reserve(identity(`other-${i}`, `principal-${i}`)));
      lease.release();
    }
    expect(() => capacity.reserve(identity())).not.toThrow();
  });

  it("uses the frozen 1024 process, 256 organization and 64 principal defaults", () => {
    const capacity = new ConnectionCapacity();
    const leases = [];
    for (let org = 0; org < 4; org++) {
      for (let principal = 0; principal < 4; principal++) {
        const scope = identity(`org-${org}`, `principal-${principal}`);
        for (let count = 0; count < 64; count++) leases.push(capacity.reserve(scope));
        rejected(() => capacity.reserve(scope));
      }
      rejected(() => capacity.reserve(identity(`org-${org}`, "another-principal")));
    }
    rejected(() => capacity.reserve(identity("another-org")));
    leases[0]!.release();
    expect(() => capacity.reserve(identity("another-org"))).not.toThrow();
    for (const lease of leases) lease.release();
  });

  it("rejects invalid or contradictory limits before accepting any identity", () => {
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      for (const key of ["global", "organization", "principal"]) {
        expect(
          () => new ConnectionCapacity({ global: 4, organization: 2, principal: 1, [key]: value }),
        ).toThrow(RangeError);
      }
    }
    expect(() => new ConnectionCapacity({ global: 2, organization: 3, principal: 1 })).toThrow(
      RangeError,
    );
    expect(() => new ConnectionCapacity({ global: 3, organization: 2, principal: 3 })).toThrow(
      RangeError,
    );
  });

  it("returns the domain error type while hiding quota scope and configured limits", () => {
    const capacity = new ConnectionCapacity({ global: 1, organization: 1, principal: 1 });
    capacity.reserve(identity("private-organization", "private-principal"));
    try {
      capacity.reserve(identity("private-organization", "private-principal"));
      expect.fail("expected admission rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect(error).toMatchObject({ message: "Connection capacity is exhausted" });
      expect(JSON.stringify(error)).not.toContain("private-");
    }
  });
});
