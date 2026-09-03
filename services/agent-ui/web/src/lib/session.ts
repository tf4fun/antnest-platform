export function csrfFromCookie(cookie: string): string {
  for (const part of cookie.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === "antnest_csrf") return decodeURIComponent(rawValue.join("="));
  }
  return "";
}
