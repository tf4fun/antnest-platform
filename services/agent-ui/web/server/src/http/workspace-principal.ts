export type WorkspacePrincipal = {
  userId: string;
  organizationId: string;
  organizationSlug: string;
  organizationName: string;
  administrator: boolean;
};

export function readWorkspacePrincipal(headers: Headers): WorkspacePrincipal | null {
  const claims = verifiedRequestContext(headers)?.claims;
  const organizationSlug = decodeDisplay(headers.get("x-antnest-organization-slug"));
  const organizationName = decodeDisplay(headers.get("x-antnest-organization-name"));
  if (!claims || organizationSlug === null || organizationName === null) return null;
  return { userId: claims.sub, organizationId: claims.org, organizationSlug, organizationName,
    administrator: claims.sys_role === "admin" || claims.org_role === "admin" };
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

import { verifiedRequestContext } from "./trusted-identity.ts";
