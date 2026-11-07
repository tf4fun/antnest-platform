const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// collectContractRoutes walks a parsed contract document and returns every
// "METHOD /path" pair found in objects carrying both a string method and a
// string path. A non-empty basePath (trailing slash trimmed) is prepended to
// each discovered path; it is supplied by callers walking a rooted subtree
// (e.g. Identity methods under identity.base_path). Results are sorted and
// deduplicated.
export function collectContractRoutes(document, basePath = "") {
  const prefix = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  const routes = new Set();
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    if (!isObject(value)) return;
    if (typeof value.method === "string" && typeof value.path === "string")
      routes.add(`${value.method} ${prefix}${value.path}`);
    for (const entry of Object.values(value)) walk(entry);
  };
  walk(document);
  return [...routes].sort();
}

// routeParityProblems returns the sorted discrepancy list between the routes a
// contract declares and the routes a router registers, in BOTH directions.
export function routeParityProblems(declaredRoutes, registeredRoutes) {
  const declared = new Set(declaredRoutes);
  const registered = new Set(registeredRoutes);
  const problems = [];
  for (const route of declared)
    if (!registered.has(route))
      problems.push(`contract route is not registered: ${route}`);
  for (const route of registered)
    if (!declared.has(route))
      problems.push(`registered route has no contract: ${route}`);
  return problems.sort();
}
