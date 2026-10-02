export type WorkspacePrincipal = {
  userId: string;
  organizationId: string;
  organizationSlug: string;
  organizationName: string;
  administrator: boolean;
};

export function readWorkspacePrincipal(headers: Headers): WorkspacePrincipal | null {
  const userId = headers.get("x-antnest-principal-id");
  const organizationId = headers.get("x-antnest-organization-id");
  const administrator = headers.get("x-antnest-administrator");
  const organizationSlug = decodeDisplay(headers.get("x-antnest-organization-slug"));
  const organizationName = decodeDisplay(headers.get("x-antnest-organization-name"));
  if (!validTrustedId(userId) || !validTrustedId(organizationId) ||
    (administrator !== "true" && administrator !== "false") ||
    organizationSlug === null || organizationName === null) return null;
  return { userId, organizationId, organizationSlug, organizationName, administrator: administrator === "true" };
}

function decodeDisplay(value: string | null): string | null {
  if (value === null || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) return null;
  try {
    // Preserve a literal BOM in the label; transport decoding never edits display text.
    const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return decoded.trim() === "" ? null : decoded;
  } catch {
    return null;
  }
}

function validTrustedId(value: string | null): value is string {
  return value !== null && value.length > 0 && value.length <= 200 &&
    value.trim() === value && !/[,\x00-\x1f\x7f]/u.test(value);
}
