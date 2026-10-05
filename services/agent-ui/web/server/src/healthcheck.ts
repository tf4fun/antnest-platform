import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { checkServerIdentity } from "node:tls";
import { X509Certificate } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ServiceAuthentication } from "./adapters/service-authentication.ts";

export async function checkReadiness(env: Record<string, string | undefined>): Promise<boolean> {
  const rawPort = env.ANTNEST_AGENT_UI_BRIDGE_PORT ?? "8080";
  const port = Number(rawPort);
  if (!/^[0-9]+$/u.test(rawPort) || !Number.isSafeInteger(port) || port < 1 || port > 65535) return false;
  let authentication: ServiceAuthentication | undefined;
  try {
    authentication = new ServiceAuthentication(env);
    const tls = authentication.serverTLS;
    return await new Promise<boolean>(resolve => {
      const options = { hostname: "127.0.0.1", port, path: "/status", agent: false as const,
        signal: AbortSignal.timeout(1500), ...(tls ? { ...tls, rejectUnauthorized: true,
          servername: env.ANTNEST_TLS_SERVER_NAME,
          checkServerIdentity: (name: string, certificate: Parameters<typeof checkServerIdentity>[1]) => {
            const error = checkServerIdentity(name, certificate); if (error) return error;
            const sans = new X509Certificate(certificate.raw).subjectAltName ?? "";
            return (sans.match(/URI:/gu) ?? []).length === 1 &&
              /(?:^|, )URI:antnest:\/\/service\/agent-ui(?=, |$)/u.test(sans)
              ? undefined : new Error("server_identity_invalid");
          } } : {}) };
      const request = (tls ? httpsGet : httpGet)(options, response => {
        response.resume(); resolve(response.statusCode === 200);
      });
      request.on("error", () => resolve(false));
    });
  } catch { return false; }
  finally { await authentication?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await checkReadiness(process.env) ? 0 : 1;
