// Read document selection independently of the product parser. Business API
// query parameters are deliberately outside this browser assertion helper.
export function workspaceLocation(value) {
  const url = value instanceof URL ? value : new URL(value);
  const match = /^\/workspace\/([^/]+)\/(?:sessions\/([^/]+))?$/.exec(
    url.pathname,
  );
  return {
    agentId: match ? decodeURIComponent(match[1]) : null,
    sessionId: match?.[2] ? decodeURIComponent(match[2]) : null,
  };
}
