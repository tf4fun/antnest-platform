export type CatalogKind =
  "provider-connections" | "model-profiles" | "templates";
export type AvailabilityChange = {
  expected_enabled: boolean;
  enabled: boolean;
};
export type AvailabilityReceipt = {
  resource_id: string;
  enabled: boolean;
  updated_at: string;
};

export type ExecutionSynchronization = {
  revision: number;
  applied_revision: number;
  updated_at: string;
  applied_at: string | null;
};

export const catalogLabels: Record<CatalogKind, string> = {
  "provider-connections": "Provider",
  "model-profiles": "Model",
  templates: "Template",
};

type ReferenceLink = { label: string; href: string };

function referenceLink(value: unknown): ReferenceLink | undefined {
  if (!value || typeof value !== "object") return;
  const item = value as Record<string, unknown>;
  if (typeof item.resource_id !== "string" || !item.resource_id.trim()) return;
  const id = item.resource_id;
  switch (item.kind) {
    case "template":
      return {
        label: `Template ${id}`,
        href: `#templates/${encodeURIComponent(id)}`,
      };
    case "agent":
      return {
        label: `Agent ${id}`,
        href: `#agents/${encodeURIComponent(id)}`,
      };
    case "lifecycle_operation":
      if (typeof item.agent_id !== "string" || !item.agent_id.trim()) return;
      return {
        label: `Operation ${id} - Agent ${item.agent_id}`,
        href: `#agents/${encodeURIComponent(item.agent_id)}`,
      };
    default:
      return;
  }
}

export function referenceLinks(details?: {
  references?: unknown;
  references_truncated?: unknown;
}): { items: ReferenceLink[]; incomplete: boolean } {
  if (!Array.isArray(details?.references))
    return { items: [], incomplete: true };
  const items = details.references.slice(0, 100).flatMap((item: unknown) => {
    const link = referenceLink(item);
    return link ? [link] : [];
  });
  return {
    items,
    incomplete:
      items.length === 0 ||
      items.length !== details.references.length ||
      (details.references_truncated !== undefined &&
        details.references_truncated !== false),
  };
}
