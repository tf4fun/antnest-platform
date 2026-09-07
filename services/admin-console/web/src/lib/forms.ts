export function slugify(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || fallback;
}

export function positiveInteger(value: FormDataEntryValue | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function csrfFromCookie(cookie: string): string {
  for (const part of cookie.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === "antnest_csrf") {
      return decodeURIComponent(rawValue.join("="));
    }
  }
  return "";
}

export function passwordChangeError(
  currentPassword: string,
  newPassword: string,
  confirmation: string,
): string {
  if (currentPassword === "") return "Enter your current password.";
  const byteLength = new TextEncoder().encode(newPassword).length;
  if (byteLength < 12) return "Use at least 12 bytes for the new password.";
  if (byteLength > 1024) return "Use no more than 1024 bytes for the new password.";
  if (newPassword !== confirmation) return "New passwords do not match.";
  return "";
}
