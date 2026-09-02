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

export function immutableImageReference(value: string): boolean {
  return /^(?:sha256:[0-9a-fA-F]{64}|[^@\s]+@sha256:[0-9a-fA-F]{64})$/.test(value.trim());
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
