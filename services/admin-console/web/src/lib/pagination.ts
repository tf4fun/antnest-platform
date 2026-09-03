export type CatalogPageOptions = {
  afterID?: string;
  limit?: number;
};

export type AgentPageOptions = {
  view?: "current" | "deleted";
  cursor?: string;
  limit?: number;
};

export type CatalogOptionPage<T> = {
  items: T[];
  next_after_id?: string | null;
};

export type CatalogOptionState<T> = {
  items: T[];
  nextAfterID?: string;
};

export function catalogPagePath(path: string, options: CatalogPageOptions = {}): string {
  return pagePath(path, [
    ["after_id", options.afterID],
    ["limit", options.limit],
  ]);
}

export function agentPagePath(options: AgentPageOptions = {}): string {
  return pagePath("/api/admin/agents", [
    ["view", options.view],
    ["cursor", options.cursor],
    ["limit", options.limit],
  ]);
}

export function mergePage<T>(current: readonly T[], incoming: readonly T[], key: (item: T) => string): T[] {
  const merged = new Map<string, T>();
  for (const item of current) merged.set(key(item), item);
  for (const item of incoming) merged.set(key(item), item);
  return [...merged.values()];
}

export function mergeCatalogOptions<T>(
  current: readonly T[],
  page: CatalogOptionPage<T>,
  key: (item: T) => string,
  eligible: (item: T) => boolean,
): CatalogOptionState<T> {
  return {
    items: mergePage(current, page.items.filter(eligible), key),
    nextAfterID: page.next_after_id ?? undefined,
  };
}

function pagePath(path: string, entries: Array<[string, string | number | undefined]>): string {
  const query = new URLSearchParams();
  for (const [name, value] of entries) {
    if (value !== undefined) query.set(name, String(value));
  }
  const encoded = query.toString();
  return encoded ? `${path}?${encoded}` : path;
}
