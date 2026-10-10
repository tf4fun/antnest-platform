export function csrfFromCookie(cookie: string): string {
  const pairs = cookie.split(";").map(part => {
    const [name, ...value] = part.trim().split("=");
    return [(name ?? "").trim(), value.join("=")] as const;
  });
  for (const name of ["__Host-antnest_csrf", "antnest_csrf"]) {
    const matches = pairs.filter(([key]) => key === name);
    if (matches.length === 0) continue;
    if (matches.length !== 1) return "";
    try { return decodeURIComponent(matches[0]![1]); }
    catch { return ""; }
  }
  return "";
}
