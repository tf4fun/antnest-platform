export function runtimeImageLabel(reference: string, source?: string): string {
  const value = source?.trim() || reference.trim();
  if (!value || value.startsWith("sha256:")) return "Platform runtime";
  return value.split("@", 1)[0] || "Platform runtime";
}
