import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Only the isolated Compose database is observed. Public lifecycle operations
// still enter the real HTTPS Gateway; SQL mutation is limited to one expiry
// fixture, since the minimum supported credential lifetime is one day.
export async function scimLifecycleFixture({
  config,
  docker,
  compose,
  signal,
}) {
  const { Pool } =
    await import("../../../services/agent-acp-service/node_modules/pg/esm/index.mjs");
  const container = async (service) => {
    const id = await docker(compose(["ps", "-q", service]));
    assert.match(id, /^[a-f0-9]{64}$/u);
    const [row] = JSON.parse(await docker(["inspect", id]));
    assert.equal(
      row.Config.Labels["com.docker.compose.project"],
      config.project,
    );
    assert.equal(row.Config.Labels["com.docker.compose.service"], service);
    assert.equal(row.State.Running, true);
    return row;
  };
  const loopback = (row, port) => {
    const bindings = row.NetworkSettings.Ports[`${port}/tcp`];
    assert.equal(bindings?.length, 1);
    assert.equal(bindings[0].HostIp, "127.0.0.1");
    assert.match(bindings[0].HostPort, /^[1-9][0-9]*$/u);
    return `http://127.0.0.1:${bindings[0].HostPort}`;
  };
  const identity = await container("identity-service");
  const relay = await container("diagnostic-relay");
  await container("postgres");
  const endpoint = loopback(identity, 8080);
  const pool = new Pool({
    host: "127.0.0.1",
    port: Number(new URL(loopback(relay, 5432)).port),
    user: "antnest_test_admin",
    password: config.env.ANTNEST_POSTGRES_ADMIN_PASSWORD,
    database: "antnest_identity",
    application_name: "issue66-observer",
    max: 1,
    connectionTimeoutMillis: 3000,
    query_timeout: 4000,
    statement_timeout: 3000,
    idle_in_transaction_session_timeout: 5000,
  });
  const query = async (sql, values = []) => {
    signal.throwIfAborted();
    try {
      return (await pool.query(sql, values)).rows;
    } catch {
      throw new Error("SCIM lifecycle fixture database query failed");
    }
  };
  const tokens = Object.fromEntries(
    ["edge-gateway", "admin-console"].map((caller) => [
      caller,
      readFileSync(
        join(config.credentials, caller, "tokens", "identity-service"),
        "utf8",
      ),
    ]),
  );
  const secrets = Object.values(tokens);
  const rpc = async (
    method,
    body,
    { caller = "edge-gateway", context } = {},
  ) => {
    const response = await fetch(`${endpoint}/rpc/identity/${method}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      headers: {
        "content-type": "application/json",
        "Antnest-Service-Authorization": `Bearer ${tokens[caller]}`,
        ...(context ? { "Antnest-Caller-Context": context } : {}),
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, `SCIM organization seed ${method}`);
    const result = await response.json();
    for (const name of ["access_token", "caller_context"])
      if (result[name]) secrets.push(result[name]);
    return result;
  };
  const administer = async (accessToken, method, body) => {
    const resolved = await rpc("resolve-access-token", {
      access_token: accessToken,
      profile: "console",
    });
    return rpc(
      method,
      {
        request_id: randomUUID(),
        actor_principal_id: resolved.principal.user_id,
        ...body,
      },
      { caller: "admin-console", context: resolved.caller_context },
    );
  };
  return {
    close: () => pool.end(),
    secrets,
    // Seed only the independent organization and its administrator. Credentials
    // used for SCIM are always issued through Console, not this fixture RPC.
    async seedOrganization(root, account, name) {
      const { organization } = await administer(
        root.client.accessToken,
        "create-organization",
        {
          slug: account.organization_slug,
          name: `SCIM isolation ${name}`,
          owner_email: "stage3-admin@example.com",
          owner_display_name: "SCIM isolation owner",
        },
      );
      const session = await rpc("local-login", {
        request_id: randomUUID(),
        organization_slug: account.organization_slug,
        email: "stage3-admin@example.com",
        password: "stage3-admin-password",
      });
      const created = await administer(
        session.access_token,
        "create-local-user",
        {
          organization_id: organization.id,
          email: account.email,
          password: account.password,
          display_name: name,
          role: "admin",
        },
      );
      assert.equal(created.user.system_role, "user");
      assert.equal(created.membership.role, "admin");
      return { organization, ...created };
    },
    async tokenSnapshot(id) {
      const [row] = await query(
        "SELECT md5((to_jsonb(t)||jsonb_build_object('xmin',t.xmin::text))::text) AS digest FROM scim_tokens t WHERE id=$1",
        [id],
      );
      assert(row?.digest, "SCIM token snapshot absent");
      return row.digest;
    },
    async principalRevocation({ traceID, membershipID, tokenID }) {
      assert.match(traceID, /^[a-f0-9]{32}$/u);
      assert.match(membershipID, /^[a-zA-Z0-9_-]{1,128}$/u);
      assert.match(tokenID, /^[a-zA-Z0-9_-]{1,128}$/u);
      // SCIM User IDs identify Memberships, not global Users. This unique JOIN
      // binds the committed feed row to the requested Membership and the
      // persisted Token's organization. Console omits organization_id from its
      // public Token projection; raw Trace omits private SQL parameters.
      const rows = await query(
        `SELECT p.sequence::text, p.user_id, p.organization_id, p.reason,
        p.traceparent, m.id AS membership_id
        FROM organization_memberships m JOIN principal_revocations p
        ON p.user_id=m.user_id AND p.organization_id=m.organization_id
        JOIN scim_tokens t ON t.organization_id=m.organization_id
        WHERE m.id=$1 AND t.id=$2
        AND p.reason='membership_deleted' AND split_part(p.traceparent,'-',2)=$3`,
        [membershipID, tokenID, traceID],
      );
      assert.equal(
        rows.length,
        1,
        "one committed SCIM principal revocation required",
      );
      return rows[0];
    },
    async assertLifecycle(token, days, issuer) {
      assert.equal(token.issued_by, issuer);
      assert.equal(token.issuer_review_required, false);
      const [row] = await query(
        `SELECT created_at=$2::timestamptz
        AND expires_at=$3::timestamptz
        AND expires_at-created_at=$4*interval '1 day'
        AND issued_by=$5 AND NOT issuer_review_required AND revoked_at IS NULL
        AND oidc_provider_id IS NOT DISTINCT FROM $6 AS matches
        FROM scim_tokens WHERE id=$1`,
        [
          token.id,
          token.created_at,
          token.expires_at,
          days,
          issuer,
          token.oidc_provider_id,
        ],
      );
      assert.equal(
        row?.matches,
        true,
        "public lifecycle metadata must match persisted metadata at full precision",
      );
    },
    async assertResource(collection, resource) {
      assert(["Users", "Groups"].includes(collection));
      const table =
        collection === "Users" ? "organization_memberships" : "groups";
      const [row] = await query(
        `SELECT created_at=$2::timestamptz
        AND updated_at=$3::timestamptz
        AND (extract(epoch FROM updated_at)*1000000000)::bigint::text=$4 AS matches
        FROM ${table} WHERE id=$1`,
        [
          resource.id,
          resource.meta.created,
          resource.meta.lastModified,
          resource.meta.version.slice(3, -1),
        ],
      );
      assert.equal(
        row?.matches,
        true,
        "public SCIM version must match persisted resource at full precision",
      );
    },
    async expire(id) {
      const rows = await query(
        "UPDATE scim_tokens SET expires_at=created_at+interval '1 microsecond' WHERE id=$1 AND revoked_at IS NULL RETURNING id",
        [id],
      );
      assert.equal(
        rows.length,
        1,
        "expiry fixture must affect exactly its own token",
      );
      return {
        token_id: id,
        fixture: "expires_at=created_at+1 microsecond",
        affected_rows: rows.length,
      };
    },
    async revoked(id) {
      const [row] = await query(
        "SELECT revoked_at IS NOT NULL AS revoked FROM scim_tokens WHERE id=$1",
        [id],
      );
      assert(row, "SCIM token absent");
      return row.revoked;
    },
    async snapshot() {
      const [row] = await query(`SELECT md5(jsonb_build_object(
        'users',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM users r),
        'members',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM organization_memberships r),
        'scim_tokens',(SELECT jsonb_agg(to_jsonb(r)||jsonb_build_object('xmin',r.xmin::text) ORDER BY id) FROM scim_tokens r),
        'groups',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM groups r),
        'group_members',(SELECT jsonb_agg(to_jsonb(r) ORDER BY group_id,organization_membership_id) FROM group_memberships r),
        'bindings',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM external_identities r),
        'notices',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM external_identity_notices r),
        'sessions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM api_tokens r),
        'events',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM identity_events r),
        'sessions_feed',(SELECT jsonb_agg(to_jsonb(r) ORDER BY sequence) FROM session_revocations r),
        'principals_feed',(SELECT jsonb_agg(to_jsonb(r) ORDER BY sequence) FROM principal_revocations r)
      )::text) AS digest`);
      assert(row?.digest);
      return row.digest;
    },
  };
}
