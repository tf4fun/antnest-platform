import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { DomainError } from "../../src/domain/errors.js";
import {
  parseExecutionConfiguration,
  parsePublicExecutionConfiguration,
  publicExecutionConfiguration,
} from "../../src/domain/execution-configuration.js";
import {
  absentExecutionDigest,
  allowsV1ToV2Upgrade,
  canonicalExecutionJSON,
  executionDigestResponse,
  executionDigestResponseSchema,
  parseExecutionAuthority,
  parseExecutionDelta,
  publicExecutionDigests,
  reconstructExecutionDelta,
  type ExecutionDelta,
} from "../../src/domain/execution-publication-v2.js";
import { executionConfiguration } from "../fixtures/execution-configuration.js";

function v2Fixture() {
  const legacy = executionConfiguration();
  return {
    ...structuredClone(legacy),
    schema_version: 2,
    providers: legacy.providers.map((provider) => ({
      connection_id: provider.connection_id,
      provider_key: provider.provider_key,
      request_protocol: provider.request_protocol,
      base_url: provider.base_url,
      enabled: provider.enabled,
      credential_revision: provider.credential_revision,
      credential: { ref: provider.connection_id, version: provider.credential_revision },
    })),
  };
}

function deltaFixture(): ExecutionDelta {
  const fixture = v2Fixture();
  return {
    schema_version: 2,
    organization_id: fixture.organization_id,
    base_revision: fixture.revision,
    revision: fixture.revision + 1,
    providers: { upserts: [], deletes: [] },
    models: { upserts: [], deletes: [] },
    agents: { upserts: [], deletes: [] },
    organization_budget: null,
  };
}

describe("execution publication v2", () => {
  it("parses a reference-only full v2 snapshot and validates public semantics", () => {
    const parsed = parseExecutionAuthority(v2Fixture());
    expect("schema_version" in parsed && parsed.schema_version).toBe(2);
  });

  it("rejects plaintext, wrong ref, wrong version, unknown and missing version", () => {
    const fixture = v2Fixture();
    for (const credential of [
      { method: "api_key", secret: "synthetic-provider-key" },
      { ref: "other-connection", version: "credential-1" },
      { ref: "provider-1", version: "credential-rotated" },
      { ref: "provider-1", version: "credential-1", secret: "x" },
    ]) {
      const input = structuredClone(fixture);
      (input.providers[0] as { credential: unknown }).credential = credential;
      expect(() => parseExecutionAuthority(input)).toThrow(DomainError);
    }
    expect(() => parseExecutionAuthority({ ...fixture, schema_version: 3 })).toThrow(DomainError);
    expect(() => parseExecutionAuthority({ ...fixture, schema_version: undefined })).toThrow(
      DomainError,
    );
    expect(() => parseExecutionAuthority({ ...fixture, schema_version: "2" })).toThrow(DomainError);
  });

  it("rejects duplicate and dangling references on full apply", () => {
    const fixture = v2Fixture();
    const duplicated = structuredClone(fixture);
    duplicated.providers.push(structuredClone(fixture.providers[0]!));
    expect(() => parseExecutionAuthority(duplicated)).toThrow(DomainError);
    const danglingModel = structuredClone(fixture);
    danglingModel.models[0]!.connection_id = "missing-provider";
    expect(() => parseExecutionAuthority(danglingModel)).toThrow(DomainError);
    const danglingAgent = structuredClone(fixture);
    danglingAgent.agents[0]!.default_model_profile_id = "missing-model";
    expect(() => parseExecutionAuthority(danglingAgent)).toThrow(DomainError);
  });

  it("produces a version-neutral public projection equal to the legacy projection", () => {
    const v2 = parseExecutionAuthority(v2Fixture());
    const v1 = parseExecutionConfiguration(executionConfiguration());
    const projection = publicExecutionConfiguration(v2);
    expect("schema_version" in projection).toBe(false);
    expect(projection).toEqual(publicExecutionConfiguration(v1));
    expect(() => parsePublicExecutionConfiguration(projection)).not.toThrow();
    expect(JSON.stringify(projection)).not.toContain("schema_version");
    expect(JSON.stringify(projection)).not.toContain("synthetic-provider-key");
  });

  it("matches the frozen shared contract schema in Ajv", () => {
    const load = (file: string): { $id?: string } & Record<string, unknown> =>
      JSON.parse(
        readFileSync(new URL("../../../../contracts/agent-acp/" + file, import.meta.url), "utf8"),
      ) as { $id?: string } & Record<string, unknown>;
    const ajv = new Ajv2020({ strict: true, validateFormats: false });
    ajv.addSchema(load("execution-snapshot.schema.json"));
    const v2 = load("execution-publication-v2.schema.json");
    const snapshot = ajv.compile(v2);
    const fixture = v2Fixture();
    expect(snapshot(fixture)).toBe(true);
    const plaintext = structuredClone(fixture);
    (plaintext.providers[0] as { credential: unknown }).credential = {
      method: "api_key",
      secret: "synthetic-provider-key",
    };
    expect(snapshot(plaintext)).toBe(false);
    const delta = ajv.getSchema(v2.$id + "#/$defs/delta")!;
    expect(delta(deltaFixture())).toBe(true);
    const digest = ajv.getSchema(v2.$id + "#/$defs/digest_response")!;
    expect(
      digest({
        organization_id: "organization-1",
        schema_version: 2,
        revision: 1,
        digest: createHash("sha256").update("x").digest("hex"),
        providers: [],
        models: [],
        agents: [],
        organization_budget_digest: null,
      }),
    ).toBe(true);
  });

  it("rejects delta duplicates, overlaps and stale ordering before mutation", () => {
    const fixture = v2Fixture();
    const provider = fixture.providers[0]!;
    for (const delta of [
      { ...deltaFixture(), providers: { upserts: [provider, provider], deletes: [] } },
      { ...deltaFixture(), providers: { upserts: [], deletes: ["a", "a"] } },
      {
        ...deltaFixture(),
        providers: { upserts: [provider], deletes: ["provider-1"] },
      },
    ]) {
      expect(() => parseExecutionDelta(delta)).toThrow(DomainError);
    }
    expect(() => parseExecutionDelta({ ...deltaFixture(), revision: 1 })).toThrow(DomainError);
    expect(() => parseExecutionDelta({ ...deltaFixture(), base_revision: 0 })).toThrow(DomainError);
  });

  it("reconstructs a delta retaining unchanged private authority and rejecting dangling finals", () => {
    const fixture = v2Fixture();
    const current = parseExecutionAuthority(fixture);
    const model = structuredClone(fixture.models[0]!);
    const agent = structuredClone(fixture.agents[0]!);
    const delta = {
      ...deltaFixture(),
      models: { upserts: [], deletes: [model.model_profile_id] },
      agents: { upserts: [], deletes: [agent.agent_id] },
    };
    const rebuilt = reconstructExecutionDelta(current as never, parseExecutionDelta(delta));
    expect(rebuilt.revision).toBe(delta.revision);
    expect(rebuilt.models).toHaveLength(0);
    expect(rebuilt.agents).toHaveLength(0);
    expect(rebuilt.providers).toEqual((current as { providers: unknown }).providers);
    const dangling = reconstructExecutionDelta;
    expect(() =>
      dangling(
        current as never,
        parseExecutionDelta({
          ...deltaFixture(),
          agents: {
            upserts: [{ ...agent, default_model_profile_id: "missing-model" }],
            deletes: [],
          },
        }),
      ),
    ).toThrow(DomainError);
    const untouchedCurrent = structuredClone(current);
    reconstructExecutionDelta(current as never, parseExecutionDelta(deltaFixture()));
    expect(current).toEqual(untouchedCurrent);
  });

  it("enforces absent/current consistency and unique identifiers on digest responses", () => {
    const hex = createHash("sha256").update("x").digest("hex");
    const base = {
      organization_id: "org",
      revision: 0,
      digest: null,
      providers: [],
      models: [],
      agents: [],
      organization_budget_digest: null,
    };
    for (const candidate of [
      { ...base, schema_version: 0, revision: 3 },
      { ...base, schema_version: 0, digest: hex },
      { ...base, schema_version: 0, providers: [{ id: "p", digest: hex }] },
      { ...base, schema_version: 2, digest: null, revision: 1 },
      { ...base, schema_version: 1, revision: 0 },
      {
        ...base,
        schema_version: 2,
        revision: 1,
        digest: hex,
        providers: [
          { id: "p", digest: hex },
          { id: "p", digest: hex },
        ],
      },
    ]) {
      expect(executionDigestResponseSchema.safeParse(candidate).success).toBe(false);
    }
    expect(executionDigestResponseSchema.safeParse({ ...base, schema_version: 0 }).success).toBe(
      true,
    );
    expect(
      executionDigestResponseSchema.safeParse({
        ...base,
        schema_version: 2,
        revision: 1,
        digest: hex,
      }).success,
    ).toBe(true);
  });

  it("builds canonical digests with escaped U+2028/29, sorted keys and no secrets", () => {
    const fixture = v2Fixture();
    const unicode = "before line after";
    const canonical = canonicalExecutionJSON({ z: 1, a: [3, { b: unicode }] });
    expect(canonical).toBe('{"a":[3,{"b":"before\\u2028line\\u2029after"}],"z":1}');
    const parsed = parseExecutionAuthority(fixture) as unknown as {
      organization_id: string;
      revision: number;
      organization_budget?: unknown;
      providers: { connection_id: string }[];
      models: { model_profile_id: string }[];
      agents: { agent_id: string }[];
    };
    const response = executionDigestResponse({ ...parsed, schema_version: 2 });
    const body = JSON.stringify(response);
    expect(body).not.toContain("synthetic-provider-key");
    expect(body).not.toContain("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8");
    expect(response.schema_version).toBe(2);
    expect(response.digest).toMatch(/^[0-9a-f]{64}$/u);
    const digests = publicExecutionDigests(parsed);
    const unprojected = publicExecutionDigests(parsed);
    expect(digests).toEqual(unprojected);
    const absent = absentExecutionDigest("org-1");
    expect(absent).toEqual({
      organization_id: "org-1",
      schema_version: 0,
      revision: 0,
      digest: null,
      providers: [],
      models: [],
      agents: [],
      organization_budget_digest: null,
    });
  });

  it("permits only an exact equal-revision v1 to v2 sealed upgrade", () => {
    const v1 = parseExecutionConfiguration(executionConfiguration());
    const v2 = parseExecutionAuthority(v2Fixture());
    expect(allowsV1ToV2Upgrade(v1, v2)).toBe(true);
    const rotated = structuredClone(v2);
    const rotatedProvider = rotated.providers[0]!;
    if (!("credential_revision" in rotatedProvider))
      throw new Error("fixture requires a credential revision");
    rotatedProvider.credential_revision = "credential-rotated";
    expect(allowsV1ToV2Upgrade(v1, rotated)).toBe(false);
    const token = structuredClone(v2);
    if (
      token.agents[0]!.runtime === null ||
      !("credential" in token.agents[0]!.runtime) ||
      token.agents[0]!.runtime.credential === undefined
    )
      throw new Error("fixture requires Runtime credential");
    token.agents[0]!.runtime.credential.token = "changed";
    expect(allowsV1ToV2Upgrade(v1, token)).toBe(false);
    expect(allowsV1ToV2Upgrade(v2, v1 as never)).toBe(false);
    expect(allowsV1ToV2Upgrade(v1, v1 as never)).toBe(false);
  });
});
