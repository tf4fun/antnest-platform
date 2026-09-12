import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";

export type PendingPermission = { id: string; request: RequestPermissionRequest };
type Entry = PendingPermission & { finish: (optionId?: string) => void };

export class PermissionInbox {
  private readonly entries = new Map<string, Entry>();
  private readonly changed: (requests: PendingPermission[]) => void;
  constructor(changed: (requests: PendingPermission[]) => void) { this.changed = changed; }

  get pending(): PendingPermission[] {
    return [...this.entries.values()].map(({id, request}) => ({id, request}));
  }

  request(request: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse> {
    if (signal.aborted) return Promise.resolve({outcome: {outcome: "cancelled"}});
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      const abort = () => finish();
      const finish = (optionId?: string) => {
        if (!this.entries.delete(id)) return;
        signal.removeEventListener("abort", abort);
        this.changed(this.pending);
        resolve({outcome: optionId === undefined ? {outcome: "cancelled"} : {outcome: "selected", optionId}});
      };
      this.entries.set(id, {id, request: structuredClone(request), finish});
      signal.addEventListener("abort", abort, {once: true});
      this.changed(this.pending);
    });
  }

  answer(id: string, optionId: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || !entry.request.options.some((option) => option.optionId === optionId)) return false;
    entry.finish(optionId);
    return true;
  }

  clear(): void {
    for (const entry of this.entries.values()) entry.finish();
  }
}
