import { inspectSessionRequestTrace } from "../acp-plan/requests.mjs";

export function inspectPrivateFileRequestTrace(trace, expected, secrets = []) {
  return inspectSessionRequestTrace(trace, expected, secrets, {
    strictPrivate: true,
    diagnosticOwner: "files",
  });
}
