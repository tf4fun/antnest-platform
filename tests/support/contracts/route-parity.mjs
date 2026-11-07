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

const HTTP_STATUS = /^\d{3}$/;

const isHttpStatus = (key) =>
  HTTP_STATUS.test(key) && Number(key) >= 100 && Number(key) <= 599;

const isBodyReference = (value) =>
  typeof value === "string" && value.length > 0;

const isValidResponseEntry = (entry) =>
  isObject(entry) &&
  Object.keys(entry).every((key) => key === "body" || key === "content_type") &&
  isBodyReference(entry.body) &&
  (entry.content_type === undefined ||
    (typeof entry.content_type === "string" && entry.content_type.length > 0));

const isValidErrorEntry = (entry) =>
  isObject(entry) &&
  Object.keys(entry).every((key) => key === "code" || key === "status") &&
  typeof entry.code === "string" &&
  entry.code.length > 0 &&
  Number.isInteger(entry.status) &&
  entry.status >= 100 &&
  entry.status <= 599;

export function routeBodyProblems(routes) {
  const problems = [];
  if (!Array.isArray(routes)) return ["routes must be an array"];
  const seen = new Set();
  routes.forEach((route, index) => {
    const declared =
      isObject(route) &&
      typeof route.method === "string" &&
      typeof route.path === "string";
    const label = declared
      ? `${route.method} ${route.path}`
      : `route[${index}]`;
    if (!isObject(route)) {
      problems.push(`route ${label}: route must declare method and path`);
      return;
    }
    if (!declared)
      problems.push(`route ${label}: route must declare method and path`);
    else if (seen.has(label)) problems.push(`duplicate route: ${label}`);
    else seen.add(label);
    const requestBody =
      route.request_body !== undefined
        ? route.request_body
        : route.request_schema;
    if (requestBody === undefined)
      problems.push(`route ${label}: missing request body declaration`);
    else if (!isBodyReference(requestBody))
      problems.push(`route ${label}: invalid request body reference`);
    const responses = route.responses;
    if (!isObject(responses) || Object.keys(responses).length === 0) {
      problems.push(`route ${label}: missing responses`);
    } else {
      for (const [status, entry] of Object.entries(responses)) {
        if (!isHttpStatus(status))
          problems.push(
            `route ${label}: invalid response status ${JSON.stringify(status)}`,
          );
        else if (!isValidResponseEntry(entry))
          problems.push(
            `route ${label}: invalid response body for status ${status}`,
          );
      }
    }
    if (route.errors !== undefined) {
      if (!Array.isArray(route.errors))
        problems.push(`route ${label}: invalid errors`);
      else
        route.errors.forEach((entry, entryIndex) => {
          if (!isValidErrorEntry(entry))
            problems.push(
              `route ${label}: invalid error entry at index ${entryIndex}`,
            );
        });
    }
  });
  return problems.sort();
}
