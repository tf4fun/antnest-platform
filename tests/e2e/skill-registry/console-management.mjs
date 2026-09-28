import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const project =
  process.env.ANTNEST_E2E_COMPOSE_PROJECT ?? "antnest-skill-console-verify";
const container = `${project}-console-e2e`;
const token =
  process.env.ANTNEST_SKILL_REGISTRY_API_TOKEN ??
  "antnest-skill-registry-local-development-token";
const org = `org_${randomBytes(16).toString("hex")}`;
const otherOrg = `org_${randomBytes(16).toString("hex")}`;
const user = `user_${randomBytes(16).toString("hex")}`;
const evidence = fileURLToPath(
  new URL(
    "../../../artifacts/verification/skill-registry-console-e2e.json",
    import.meta.url,
  ),
);

function docker(...args) {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

function archive(body) {
  const program = `import io,sys,zipfile\nb=io.BytesIO()\nwith zipfile.ZipFile(b,'w',compression=zipfile.ZIP_DEFLATED) as z:\n z.writestr('SKILL.md','---\\nname: code-review\\ndescription: Review code changes\\n---\\n'+sys.argv[1]+'\\n')\nsys.stdout.buffer.write(b.getvalue())`;
  return execFileSync("python3", ["-c", program, body]);
}

function principal(organization = org, role = "admin") {
  return {
    "X-Antnest-User-ID": user,
    "X-Antnest-Organization-ID": organization,
    "X-Antnest-Membership-ID": "membership-1",
    "X-Antnest-System-Role": "user",
    "X-Antnest-Organization-Role": role,
  };
}

async function main() {
  let started = false;
  let catalogServer;
  const catalogCalls = [];
  const publishedVersions = new Map();
  const revisions = new Map();
  const stop = () => {
    if (started) docker("rm", "-f", container);
    started = false;
  };
  const interrupt = () => {
    stop();
    process.exit(130);
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    catalogServer = createServer(async (request, response) => {
      const path = new URL(request.url, "http://localhost").pathname;
      if (
        request.method === "POST" &&
        (path === "/internal/agent-templates" ||
          path === "/internal/agent-templates/template-1/revisions")
      ) {
        try {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const command = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          catalogCalls.push({ path, command });
          const revision = path.endsWith("/revisions") ? 2 : 1;
          const frozen = command.skill_refs.map((ref) =>
            publishedVersions.get(ref.version),
          );
          assert.ok(frozen.every(Boolean));
          const record = {
            template_id: "template-1",
            name: command.name,
            revision,
            model_profile_id: command.model_profile_id,
            fallback_model_profile_ids: command.fallback_model_profile_ids,
            system_prompt: command.system_prompt,
            max_model_requests: command.max_model_requests,
            context_policy_version: command.context_policy_version,
            runtime: command.runtime,
            skill_refs: frozen,
            skill_set_digest: `sha256:${String(revision).repeat(64)}`,
            enabled: true,
          };
          revisions.set(revision, record);
          response
            .writeHead(201, { "Content-Type": "application/json" })
            .end(JSON.stringify(record));
        } catch (error) {
          response
            .writeHead(500, { "Content-Type": "application/json" })
            .end(
              JSON.stringify({ code: "stub_error", message: String(error) }),
            );
        }
        return;
      }
      const match = path.match(
        /^\/internal\/agent-templates\/template-1\/revisions\/(\d+)$/,
      );
      if (
        request.method === "GET" &&
        match &&
        revisions.has(Number(match[1]))
      ) {
        response
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify(revisions.get(Number(match[1]))));
        return;
      }
      response
        .writeHead(404, { "Content-Type": "application/json" })
        .end(JSON.stringify({ code: "not_found" }));
    });
    await new Promise((resolve, reject) => {
      catalogServer.once("error", reject);
      catalogServer.listen(0, "0.0.0.0", resolve);
    });
    const catalogPort = catalogServer.address().port;
    docker(
      "run",
      "-d",
      "--name",
      container,
      "--network",
      `${project}_development`,
      "-p",
      "127.0.0.1::8080",
      "-e",
      "ANTNEST_IDENTITY_SERVICE_URL=http://identity-service:8080",
      "-e",
      `ANTNEST_AGENT_CONTROLLER_URL=http://host.docker.internal:${catalogPort}`,
      "-e",
      "ANTNEST_AGENT_ACP_SERVICE_URL=http://agent-acp-service:8080",
      "-e",
      "ANTNEST_SKILL_REGISTRY_URL=http://skill-registry:8080",
      "-e",
      `ANTNEST_SKILL_REGISTRY_API_TOKEN=${token}`,
      "antnest/admin-console:local",
    );
    started = true;
    const binding = docker("port", container, "8080/tcp").split("\n")[0];
    const base = `http://${binding}`;
    async function call(
      method,
      path,
      organization = org,
      body,
      key,
      role = "admin",
    ) {
      const headers = principal(organization, role);
      if (key) headers["Idempotency-Key"] = key;
      if (typeof body === "string")
        headers["Content-Type"] = "application/json";
      const response = await fetch(base + path, { method, headers, body });
      const payload = response.headers
        .get("content-type")
        ?.includes("application/zip")
        ? Buffer.from(await response.arrayBuffer())
        : await response.json();
      return { response, payload };
    }
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        if ((await fetch(base + "/status")).ok) {
          ready = true;
          break;
        }
      } catch {
        /* starting */
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(ready, "Console failed to start");
    const empty = await call("GET", "/api/admin/skills");
    assert.equal(empty.response.status, 200);
    assert.deepEqual(empty.payload.items, []);

    const initial = archive("First revision.");
    const form = new FormData();
    form.append(
      "artifact",
      new Blob([initial], { type: "application/zip" }),
      "code-review.zip",
    );
    const first = await call(
      "POST",
      "/api/admin/skills",
      org,
      form,
      "skill-create-attempt-0001",
    );
    assert.equal(first.response.status, 201, JSON.stringify(first.payload));
    assert.equal(first.payload.version, 1);
    const replayForm = new FormData();
    replayForm.append(
      "artifact",
      new Blob([initial], { type: "application/zip" }),
      "code-review.zip",
    );
    const replay = await call(
      "POST",
      "/api/admin/skills",
      org,
      replayForm,
      "skill-create-attempt-0001",
    );
    assert.equal(replay.response.status, 201);
    assert.deepEqual(replay.payload, first.payload);
    const skillID = first.payload.skill_id;
    publishedVersions.set(1, first.payload);
    const listed = await call("GET", "/api/admin/skills");
    assert.equal(listed.payload.items[0].skill_id, skillID);
    const versions = await call("GET", `/api/admin/skills/${skillID}/versions`);
    assert.deepEqual(
      versions.payload.items.map((item) => item.version),
      [1],
    );
    const downloaded = await call(
      "GET",
      `/api/admin/skills/${skillID}/versions/1/artifact`,
    );
    assert.equal(downloaded.response.status, 200);
    assert.equal(
      createHash("sha256").update(downloaded.payload).digest("hex"),
      createHash("sha256").update(initial).digest("hex"),
    );

    const secondForm = new FormData();
    secondForm.append("expected_version", "1");
    secondForm.append(
      "artifact",
      new Blob([archive("Second revision.")], { type: "application/zip" }),
      "code-review-v2.zip",
    );
    const second = await call(
      "POST",
      `/api/admin/skills/${skillID}/versions`,
      org,
      secondForm,
      "skill-revise-attempt-0001",
    );
    assert.equal(second.response.status, 201, JSON.stringify(second.payload));
    assert.equal(second.payload.version, 2);
    publishedVersions.set(2, second.payload);
    const templateInput = {
      name: "Skill template",
      model_profile_id: "model-1",
      system_prompt: "Use the preset.",
      max_model_requests: 32,
      runtime: { image_ref: "antnest/antnest-runtime:local" },
      skill_refs: [{ skill_id: skillID, version: 1 }],
    };
    const created = await call(
      "POST",
      "/api/admin/templates",
      org,
      JSON.stringify(templateInput),
      "template-create-attempt-0001",
    );
    assert.equal(created.response.status, 201, JSON.stringify(created.payload));
    assert.equal(
      created.payload.skill_refs[0].artifact_digest,
      first.payload.artifact_digest,
    );
    assert.deepEqual(catalogCalls[0].command.skill_refs, [
      { skill_id: skillID, version: 1 },
    ]);
    assert.equal(catalogCalls[0].command.organization_id, org);
    const revised = await call(
      "POST",
      "/api/admin/templates/template-1/revisions",
      org,
      JSON.stringify({
        ...templateInput,
        skill_refs: [{ skill_id: skillID, version: 2 }],
      }),
      "template-revise-attempt-0001",
    );
    assert.equal(revised.response.status, 201, JSON.stringify(revised.payload));
    assert.equal(
      revised.payload.skill_refs[0].artifact_digest,
      second.payload.artifact_digest,
    );
    assert.deepEqual(catalogCalls[1].command.skill_refs, [
      { skill_id: skillID, version: 2 },
    ]);
    const historical = await call(
      "GET",
      "/api/admin/templates/template-1/revisions/1",
    );
    assert.equal(historical.response.status, 200);
    assert.equal(
      historical.payload.skill_refs[0].artifact_digest,
      first.payload.artifact_digest,
    );
    const staleForm = new FormData();
    staleForm.append("expected_version", "1");
    staleForm.append(
      "artifact",
      new Blob([archive("Third revision.")], { type: "application/zip" }),
      "code-review-v3.zip",
    );
    const stale = await call(
      "POST",
      `/api/admin/skills/${skillID}/versions`,
      org,
      staleForm,
      "skill-stale-attempt-0001",
    );
    assert.equal(stale.response.status, 409);
    assert.equal(stale.payload.code, "revision_conflict");
    const isolated = await call("GET", "/api/admin/skills", otherOrg);
    assert.deepEqual(isolated.payload.items, []);
    const hidden = await call(
      "GET",
      `/api/admin/skills/${skillID}/versions`,
      otherOrg,
    );
    assert.equal(hidden.response.status, 404);
    const forbidden = await call(
      "GET",
      "/api/admin/skills",
      org,
      undefined,
      undefined,
      "member",
    );
    assert.equal(forbidden.response.status, 403);

    const result = {
      scope:
        "Docker Registry+PostgreSQL+Console BFF with catalog dependency stub",
      initialVersion: 1,
      latestVersion: 2,
      replay: "same receipt",
      conflict: 409,
      crossOrganization: 404,
      member: 403,
      artifactDigest: "matched",
      templateRevisions: catalogCalls.length,
      historicalSkillFrozen: true,
    };
    await mkdir(
      fileURLToPath(
        new URL("../../../artifacts/verification/", import.meta.url),
      ),
      { recursive: true },
    );
    await writeFile(evidence, JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result));
  } finally {
    stop();
    if (catalogServer) {
      catalogServer.closeAllConnections();
      await new Promise((resolve) => catalogServer.close(resolve));
    }
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

await main();
