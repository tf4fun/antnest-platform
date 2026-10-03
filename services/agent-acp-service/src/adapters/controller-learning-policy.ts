import {
  learningPolicySchema,
  learningScopedId,
  type LearningPolicy,
} from "../domain/learning-policy.js";

export type LearningPolicyScope = {
  organizationId: string;
  agentId: string;
  ownerId: string;
};

export class LearningPolicyReadError extends Error {
  public constructor(public readonly code: "access_denied" | "policy_unavailable") {
    super(`Controller learning policy ${code}`);
  }
}

const MAX_POLICY_BYTES = 16 * 1024;

export class ControllerLearningPolicyClient {
  private readonly baseUrl: URL;

  public constructor(
    baseUrl: string,
    private readonly fetcher: (input: string | URL, init: RequestInit) => Promise<Response>,
  ) {
    this.baseUrl = new URL(baseUrl);
    if (
      !["http:", "https:"].includes(this.baseUrl.protocol) ||
      this.baseUrl.username !== "" ||
      this.baseUrl.password !== "" ||
      this.baseUrl.search !== "" ||
      this.baseUrl.hash !== ""
    )
      throw new Error("Invalid Controller policy endpoint");
  }

  public async read(scope: LearningPolicyScope): Promise<LearningPolicy> {
    if (
      !learningScopedId.test(scope.organizationId) ||
      !learningScopedId.test(scope.agentId) ||
      !learningScopedId.test(scope.ownerId)
    )
      throw new Error("Invalid verified learning policy scope");
    const endpoint = new URL(
      `/internal/agents/${scope.agentId}/skill-learning-policy`,
      this.baseUrl,
    );
    endpoint.searchParams.set("organization_id", scope.organizationId);
    endpoint.searchParams.set("principal_id", scope.ownerId);

    let response: Response;
    try {
      response = await this.fetcher(endpoint.toString(), {
        method: "GET",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new LearningPolicyReadError("policy_unavailable");
    }
    if (response.status === 403 || response.status === 404)
      throw new LearningPolicyReadError("access_denied");
    if (response.status !== 200) throw new LearningPolicyReadError("policy_unavailable");

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBoundedBody(response));
    } catch {
      throw new LearningPolicyReadError("policy_unavailable");
    }
    const result = learningPolicySchema.safeParse(parsed);
    if (
      !result.success ||
      result.data.organization_id !== scope.organizationId ||
      result.data.agent_id !== scope.agentId ||
      result.data.owner_principal_id !== scope.ownerId
    )
      throw new LearningPolicyReadError("policy_unavailable");
    return result.data;
  }
}

async function readBoundedBody(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_POLICY_BYTES)
    throw new Error("Controller learning policy response is too large");
  if (response.body === null) throw new Error("Controller learning policy response is empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_POLICY_BYTES)
        throw new Error("Controller learning policy response is too large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
    if (size > MAX_POLICY_BYTES) await response.body.cancel().catch(() => {});
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}
