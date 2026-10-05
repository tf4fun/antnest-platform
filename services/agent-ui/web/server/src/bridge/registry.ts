export type BridgeScope = {
  organizationId: string;
  principalId: string;
  agentId: string;
};

export type BridgeOwner = {
  beginDrain?(): void | Promise<void>;
  close(): void | Promise<void>;
  isClosed?: boolean;
};

export type BridgeLease<Owner extends BridgeOwner> = {
  owner: Owner;
  epoch: string;
  incarnation: string;
  retainWork(): () => void;
  release(): void;
};

type RegistryOptions<Owner extends BridgeOwner> = {
  create(
    scope: BridgeScope,
    retainWork: () => () => void,
    identity: { epoch: string; incarnation: string },
  ): Owner | Promise<Owner>;
  now(): number;
  idleMs: number;
  maxOwners?: number;
  epoch(): string;
  incarnation(): string;
};

type Slot<Owner extends BridgeOwner> = {
  scope: BridgeScope;
  owner: Promise<Owner>;
  incarnation: string;
  observers: number;
  work: number;
  idleSince?: number;
  retiring?: Promise<void>;
};

export class BridgeCapacityError extends Error {
  public constructor() {
    super("Bridge owner capacity is exhausted");
    this.name = "BridgeCapacityError";
  }
}

export class BridgeRegistry<Owner extends BridgeOwner> {
  private readonly slots = new Map<string, Slot<Owner>>();
  private readonly epoch: string;
  private readonly options: RegistryOptions<Owner>;
  private readonly idleWaiters = new Set<() => void>();
  private draining = false;
  private drainPromise: Promise<{ forced: boolean }> | null = null;

  public constructor(options: RegistryOptions<Owner>) {
    if (!Number.isFinite(options.idleMs) || options.idleMs < 0)
      throw new RangeError(
        "Bridge idle lifetime must be nonnegative and finite",
      );
    if (!Number.isSafeInteger(options.maxOwners ?? 16) ||
      (options.maxOwners ?? 16) < 1)
      throw new RangeError("Invalid Bridge owner capacity");
    this.epoch = options.epoch();
    this.options = options;
  }

  public snapshotMetrics(): { owners: number; observerLeases: number; heldWork: number } {
    let observerLeases = 0;
    let heldWork = 0;
    for (const slot of this.slots.values()) {
      observerLeases += slot.observers;
      heldWork += slot.work;
    }
    return { owners: this.slots.size, observerLeases, heldWork };
  }

  public async observe(scope: BridgeScope): Promise<BridgeLease<Owner>> {
    if (this.draining) throw new Error("Bridge is draining");
    const key = scopeKey(scope);
    let slot = this.slots.get(key);
    if (slot) refreshScopeContext(slot.scope, scope);
    if (slot?.retiring !== undefined) {
      await slot.retiring;
      return this.observe(scope);
    }
    if (slot === undefined) {
      if (this.slots.size >= (this.options.maxOwners ?? 16)) {
        const cold = [...this.slots].find(([, candidate]) =>
          candidate.retiring === undefined &&
          candidate.observers === 0 &&
          candidate.work === 0,
        );
        if (cold === undefined) throw new BridgeCapacityError();
        await this.retire(cold[0], cold[1]);
        return this.observe(scope);
      }
      let resolveOwner!: (owner: Owner) => void;
      let rejectOwner!: (error: unknown) => void;
      const owner = new Promise<Owner>((resolve, reject) => {
        resolveOwner = resolve;
        rejectOwner = reject;
      });
      slot = {
        scope,
        owner,
        incarnation: this.options.incarnation(),
        observers: 0,
        work: 0,
      };
      const current = slot;
      this.slots.set(key, current);
      try {
        const retainWork = () => {
          if (
            this.draining ||
            current.retiring !== undefined ||
            this.slots.get(key) !== current
          )
            throw new Error("Cannot retain work for a retired Bridge owner");
          return this.retainSlotWork(current);
        };
        const created = this.options.create(scope, retainWork, {
          epoch: this.epoch,
          incarnation: current.incarnation,
        });
        Promise.resolve(created).then(resolveOwner, rejectOwner);
      } catch (error) {
        this.slots.delete(key);
        throw error;
      }
    }
    slot.observers += 1;
    slot.idleSince = undefined;
    let owner: Owner;
    try {
      owner = await slot.owner;
    } catch (error) {
      if (this.slots.get(key) === slot) this.slots.delete(key);
      throw error;
    }
    if (owner.isClosed === true) {
      slot.observers -= 1;
      this.markIdle(slot);
      await this.retire(key, slot);
      return this.observe(scope);
    }
    if (this.draining) {
      slot.observers -= 1;
      this.markIdle(slot);
      throw new Error("Bridge is draining");
    }
    let released = false;
    const current = slot;
    return {
      owner,
      epoch: this.epoch,
      incarnation: current.incarnation,
      retainWork: () => {
        if (released || this.draining)
          throw new Error("Cannot retain work after releasing the observer");
        return this.retainSlotWork(current);
      },
      release: () => {
        if (released) return;
        released = true;
        current.observers -= 1;
        this.markIdle(current);
      },
    };
  }

  public async sweep(): Promise<void> {
    if (this.draining) return;
    const closings: Promise<void>[] = [];
    for (const [key, slot] of this.slots) {
      if (
        slot.retiring !== undefined ||
        slot.observers > 0 ||
        slot.work > 0 ||
        slot.idleSince === undefined ||
        this.options.now() - slot.idleSince < this.options.idleMs
      )
        continue;
      closings.push(this.retire(key, slot));
    }
    await Promise.all(closings);
  }

  public drain(timeoutMs: number): Promise<{ forced: boolean }> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0)
      throw new RangeError("Invalid Bridge drain timeout");
    if (this.drainPromise !== null) return this.drainPromise;
    this.draining = true;
    this.drainPromise = this.finishDrain(Date.now() + timeoutMs);
    return this.drainPromise;
  }

  private async finishDrain(deadline: number): Promise<{ forced: boolean }> {
    const streamClosures = Promise.allSettled(
      [...this.slots.values()].map((slot) =>
        slot.owner.then((owner) => owner.beginDrain?.()),
      ),
    );
    const streamsClosed = await until(streamClosures, deadline);
    const streamFailures =
      streamsClosed &&
      (await streamClosures).some((result) => result.status === "rejected");
    const idle = streamsClosed && (await this.waitForIdle(deadline));
    const closings = Promise.allSettled(
      [...this.slots].map(([key, slot]) => this.retire(key, slot)),
    );
    const ownersClosed = await until(closings, deadline);
    const closeFailures =
      ownersClosed &&
      (await closings).some((result) => result.status === "rejected");
    return {
      forced: !idle || !ownersClosed || streamFailures || closeFailures,
    };
  }

  private waitForIdle(deadline: number): Promise<boolean> {
    if (this.allIdle()) return Promise.resolve(true);
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining === 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const complete = (idle: boolean) => {
        clearTimeout(timer);
        this.idleWaiters.delete(check);
        resolve(idle);
      };
      const check = () => {
        if (this.allIdle()) complete(true);
      };
      const timer = setTimeout(() => complete(false), remaining);
      this.idleWaiters.add(check);
      check();
    });
  }

  private allIdle(): boolean {
    return [...this.slots.values()].every(
      (slot) => slot.observers === 0 && slot.work === 0,
    );
  }

  private retire(key: string, slot: Slot<Owner>): Promise<void> {
    if (slot.retiring !== undefined) return slot.retiring;
    slot.retiring = slot.owner
      .then((owner) => owner.close())
      .finally(() => {
        if (this.slots.get(key) === slot) this.slots.delete(key);
      });
    return slot.retiring;
  }

  private markIdle(slot: Slot<Owner>): void {
    if (slot.observers === 0 && slot.work === 0 && slot.idleSince === undefined)
      slot.idleSince = this.options.now();
    for (const check of this.idleWaiters) check();
  }

  private retainSlotWork(slot: Slot<Owner>): () => void {
    slot.work += 1;
    slot.idleSince = undefined;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      slot.work -= 1;
      this.markIdle(slot);
    };
  }
}

async function until<T>(
  promise: Promise<T>,
  deadline: number,
): Promise<boolean> {
  const remaining = Math.max(0, deadline - Date.now());
  if (remaining === 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), remaining);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function scopeKey(scope: BridgeScope): string {
  return JSON.stringify([
    scope.organizationId,
    scope.principalId,
    scope.agentId,
  ]);
}
import { refreshScopeContext } from "../http/trusted-identity.ts";
