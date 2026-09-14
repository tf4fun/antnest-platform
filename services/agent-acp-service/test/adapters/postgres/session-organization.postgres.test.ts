import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresKernel } from "../../../src/adapters/postgres/kernel.js";
import { migrate } from "../../../src/adapters/postgres/migrate.js";
import { SecretBox } from "../../../src/adapters/postgres/secret-box.js";
import { PostgresSessionRepository } from "../../../src/adapters/postgres/session-repository.js";
import { PostgresRunRepository } from "../../../src/adapters/postgres/run-repository.js";
import { binding } from "../../support/fixtures.js";

const url = process.env.ANTNEST_ACP_TEST_DATABASE_URL;

describe.skipIf(url === undefined)("durable Session organization", () => {
  const pool = new Pool({ connectionString: url, max: 2 });
  const kernel = new PostgresKernel(pool);
  const sessions = new PostgresSessionRepository(kernel, new SecretBox(randomBytes(32)));
  const runs = new PostgresRunRepository(kernel);

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await migrate(pool);
  });
  afterAll(async () => {
    await pool.end();
  });

  it("persists, forks and lists organization ownership without a live Agent projection", async () => {
    const one = randomUUID();
    const two = randomUUID();
    for (const [id, organizationId] of [
      [one, "organization-1"],
      [two, "organization-2"],
    ] as const) {
      await sessions.create({
        sessionId: id,
        binding: { ...binding(), organizationId },
        cwd: "/workspace",
        mcpRevisionId: randomUUID(),
        mcpSources: [],
      });
    }
    const fork = randomUUID();
    await sessions.fork({
      sourceSessionId: one,
      sessionId: fork,
      mcpRevisionId: randomUUID(),
      mcpSources: [],
      createdAt: new Date(),
    });
    const restarted = new PostgresSessionRepository(kernel, new SecretBox(randomBytes(32)));
    for (const id of [one, fork]) {
      expect(await restarted.get(id)).toMatchObject({ organizationId: "organization-1" });
      expect(await runs.getSession(id)).toMatchObject({ organizationId: "organization-1" });
    }
    const list = await restarted.list({
      organizationId: "organization-1",
      principalId: "principal-1",
      agentId: "agent-1",
      cwd: undefined,
      cursor: undefined,
      limit: 50,
    });
    expect(list.sessions.map((session) => session.id).sort()).toEqual([one, fork].sort());
    expect(
      (await pool.query("SELECT count(*)::int AS count FROM execution_configurations")).rows,
    ).toEqual([{ count: 0 }]);
  });
});
