export const fields = (values) =>
  Object.entries(values).map(([key, value]) => ({ key, value }));

export function databaseRequest(
  traceID,
  serverID,
  clientID,
  processID,
  route,
  method = "POST",
  rpcMethod = `${method} ${route}`,
) {
  const child = (spanID) => [{ refType: "CHILD_OF", traceID, spanID }];
  return [
    {
      traceID,
      spanID: serverID,
      processID,
      duration: 10,
      operationName: `HTTP ${method} ${route}`,
      references: child(clientID),
      tags: fields({
        "span.kind": "server",
        "http.request.method": method,
        "http.route": route,
        "rpc.method": rpcMethod,
        "http.response.status_code": 200,
      }),
    },
    {
      traceID,
      spanID: `${serverID}-db`,
      processID,
      duration: 1,
      operationName: "SELECT",
      references: child(serverID),
      tags: fields({
        "span.kind": "client",
        "db.system.name": "postgresql",
        "db.query.text": "SELECT $1",
        "db.operation.name": "SELECT",
      }),
    },
  ];
}
