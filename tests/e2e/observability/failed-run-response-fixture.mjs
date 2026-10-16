import { setTag } from "./gateway-resolution-fixtures.mjs";

// Production v1 dispatch reports the RequestError created after a failed Run;
// model_unsupported_content and retryable belong to the independent wire receipt.
export function addFailedV1RunResponse(
  request,
  {
    http = false,
    causeTypes = "[]",
    timestamp = request.startTime + request.duration - 1,
  } = {},
) {
  request.operationName = http ? "HTTP POST /v1/acp" : "acp session/prompt";
  for (const [key, value] of Object.entries({
    "span.kind": "server",
    "rpc.method": "session/prompt",
    "antnest.protocol.version": "v1",
    "error.type": "RequestError",
    "error.code": "-32022",
    "antnest.error.code": "-32022",
    "rpc.response.status_code": -32022,
    "otel.status_code": "ERROR",
    "antnest.outcome": "error",
    "antnest.operation.phase": "acp.dispatch",
    ...(http
      ? {
          "http.request.method": "POST",
          "http.route": "/v1/acp",
          "http.response.status_code": 202,
        }
      : {}),
  }))
    setTag(request, key, value);
  request.logs = [
    {
      timestamp,
      fields: Object.entries({
        event: "antnest.error",
        "antnest.error.stage": "acp.dispatch",
        "antnest.error.type": "RequestError",
        "antnest.error.code": "-32022",
        "antnest.error.message": "Operation reported -32022",
        "antnest.error.cause_types": causeTypes,
        "antnest.error.causes": JSON.stringify([
          {
            type: "RequestError",
            code: -32022,
            message: "Operation reported -32022",
          },
        ]),
        "antnest.operation.phase": "acp.dispatch",
      }).map(([key, value]) => ({ key, value })),
    },
  ];
}
