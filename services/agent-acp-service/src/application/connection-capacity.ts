import { DomainError } from "../domain/errors.js";

export type ConnectionCapacityLimits = {
  readonly global: number;
  readonly organization: number;
  readonly principal: number;
};

type OrganizationCapacity = {
  count: number;
  principals: Map<string, number>;
};

export class ConnectionCapacity {
  private readonly globalLimit: number;
  private readonly organizationLimit: number;
  private readonly principalLimit: number;
  private readonly organizations = new Map<string, OrganizationCapacity>();
  private count = 0;

  public constructor(
    limits: ConnectionCapacityLimits = {
      global: 1024,
      organization: 256,
      principal: 64,
    },
  ) {
    const global = limits.global;
    const organization = limits.organization;
    const principal = limits.principal;
    if (
      ![global, organization, principal].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      ) ||
      principal > organization ||
      organization > global
    ) {
      throw new RangeError("Invalid connection capacity limits");
    }
    this.globalLimit = global;
    this.organizationLimit = organization;
    this.principalLimit = principal;
  }

  public reserve({
    organizationId,
    principalId,
  }: {
    readonly organizationId: string;
    readonly principalId: string;
  }): { release(): void } {
    const existing = this.organizations.get(organizationId);
    const principalCount = existing?.principals.get(principalId) ?? 0;
    if (
      this.count >= this.globalLimit ||
      (existing?.count ?? 0) >= this.organizationLimit ||
      principalCount >= this.principalLimit
    ) {
      throw new DomainError("connection_quota_exceeded", "Connection capacity is exhausted");
    }

    const organization = existing ?? { count: 0, principals: new Map<string, number>() };
    if (!existing) this.organizations.set(organizationId, organization);
    this.count += 1;
    organization.count += 1;
    organization.principals.set(principalId, principalCount + 1);

    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.count -= 1;
        organization.count -= 1;
        const remaining = organization.principals.get(principalId)! - 1;
        if (remaining === 0) organization.principals.delete(principalId);
        else organization.principals.set(principalId, remaining);
        if (organization.count === 0) this.organizations.delete(organizationId);
      },
    };
  }
}
