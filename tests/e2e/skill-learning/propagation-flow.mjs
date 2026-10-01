import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "../../../services/agent-ui/web/node_modules/playwright/index.mjs";
import { workspaceLocation } from "../../support/agent-ui/workspace-location.mjs";
import {
  assertAgentDeleted,
  assertAgentDisabled,
  waitForAgentReady,
} from "../../support/verification/agent-state.mjs";
import { searchJaegerTraces } from "../../support/jaeger-search.mjs";
import {
  assertCaptureDisabled,
  tag,
  traceTopology,
} from "../observability/trace-tree.mjs";
import { assertFrozenSkill } from "../skill-registry/stage3-fixture.mjs";
import { member, until } from "../workspace-closeout/c4-setup.mjs";

const skillName = "fixture-procedure";
const firstRule = "For the fixture task, inspect the target before editing it.";
const secondRule = "For the fixture task, check the result after editing it.";
const hash = (value) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

// DI1 uses actual Gateway sessions, ACP source reads, Console publication,
// Controller revisions and RC named volumes. No browser request is fulfilled.
export async function openPropagationFlow({
  config,
  fixture,
  docker,
  sql,
  signal,
  output,
}) {
  await mkdir(output, { recursive: true, mode: 0o700 });
  const report = {
    status: "running",
    source_agent_id: fixture.agentID,
    checks: [],
    publications: [],
    lifecycle: [],
    runs: [],
  };
  const bodies = new Map();
  const browser = await chromium.launch({
    headless: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  let closing;
  const close = () => (closing ??= browser.close());
  const abort = () => void close().catch(() => {});
  signal.addEventListener("abort", abort, { once: true });
  const cleanupSetupFailure = async (error) => {
    signal.removeEventListener("abort", abort);
    await close();
    throw error;
  };
  const context = await browser
    .newContext({
      viewport: { width: 1360, height: 900 },
    })
    .catch(cleanupSetupFailure);
  const errors = [];
  const track = (page) => {
    page.setDefaultTimeout(30000);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("websocket", () => errors.push("unexpected browser WebSocket"));
    return page;
  };
  const page = track(await context.newPage().catch(cleanupSetupFailure));
  const checkpoint = async (label) => {
    report.checks.push(label);
    await writeFile(`${output}/progress.json`, JSON.stringify(report), {
      mode: 0o600,
    });
    console.log(`Propagation ${config.project}: ${label}`);
  };
  const request = async (path, body, key = randomUUID()) => {
    signal.throwIfAborted();
    const cookies = await context.cookies(config.gateway);
    return context.request.fetch(config.gateway + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Origin: config.gateway,
        "X-Antnest-CSRF-Token":
          cookies.find((cookie) => cookie.name === "antnest_csrf")?.value ?? "",
        "Idempotency-Key": key,
      },
      ...(body === undefined ? {} : { data: body }),
      timeout: 15000,
    });
  };
  const json = async (path, body, status = 200, key) => {
    const response = await request(path, body, key);
    assert.equal(response.status(), status, `${path}: unexpected HTTP status`);
    return response.json();
  };
  const login = async () => {
    await context.clearCookies();
    const response = await context.request.post(
      config.gateway + "/api/session/login",
      { data: member, headers: { Origin: config.gateway } },
    );
    assert.equal(response.status(), 200);
    const value = await response.json();
    assert.equal(value.principal.user_id, fixture.ownerID);
    return value;
  };
  const templateCommand = (version) => ({
    name: "DI1 propagated procedure",
    model_profile_id: fixture.template.model_profile_id,
    system_prompt:
      "Verify the frozen system Skill through ordinary Runtime read.",
    max_model_requests: 8,
    runtime: { image_ref: config.image },
    skill_refs: [{ skill_id: version.skill_id, version: version.version }],
  });
  const admit = async (path, body, kind) => {
    const key = randomUUID();
    let response = await request(path, body, key);
    const preparation = [];
    if (response.status() === 503) {
      assert.equal((await response.json()).retryable, true);
      await until(
        async () => {
          const progress = await json(
            "/api/admin/agent-skill-preparations/by-idempotency-key",
            undefined,
            200,
            key,
          );
          assert.equal(progress.kind, kind);
          assert(
            ["queued", "preparing", "retry_wait", "ready"].includes(
              progress.state,
            ),
            "preparation must remain recoverable",
          );
          preparation.push({
            state: progress.state,
            verified_packages: progress.progress.verified_packages,
          });
          return progress.state === "ready";
        },
        "target Skill set ready before lifecycle admission",
        signal,
        120000,
      );
      response = await request(path, body, key);
    }
    assert.equal(response.status(), 202, `${kind}: lifecycle was not admitted`);
    const accepted = await response.json();
    const operation = accepted.operation ?? accepted;
    await fixture.operation(operation.request_id);
    const agentId = accepted.agent?.agent_id ?? operation.agent_id;
    assert.match(agentId, /^agent_[a-f0-9]{32}$/u);
    const ready = await waitForAgentReady(
      () => json(`/api/admin/agents/${agentId}`),
      signal,
    );
    report.lifecycle.push({
      kind,
      agent_id: agentId,
      request_id: operation.request_id,
      preparation,
      executable_execution_revision: ready.executable_execution_revision,
    });
    return ready;
  };
  const volume = async (agentId, template, version) => {
    const mounts = JSON.parse(
      await docker([
        "inspect",
        "--format",
        "{{json .Mounts}}",
        `antnest-runtime-${agentId}`,
      ]),
    );
    const mount = mounts.find((item) => item.Destination === "/skills");
    assert.equal(mount?.Type, "volume");
    assert.equal(mount.RW, false, "preset packages must be mounted read-only");
    const inspected = JSON.parse(
      await docker(["volume", "inspect", mount.Name]),
    )[0];
    assert.equal(
      inspected.Labels["io.antnest.skill-set-digest"],
      template.skill_set_digest,
    );
    const manifest = JSON.parse(
      await docker([
        "exec",
        "--user",
        "1000",
        `antnest-runtime-${agentId}`,
        "cat",
        "/skills/.antnest-skills.json",
      ]),
    );
    assert.equal(manifest.agent_id, agentId);
    assert.equal(manifest.skill_set_digest, template.skill_set_digest);
    assert.equal(manifest.layout_version, 1);
    assert.equal(manifest.skills.length, 1);
    const frozen = manifest.skills[0];
    for (const field of [
      "skill_id",
      "version",
      "name",
      "artifact_digest",
      "content_digest",
    ])
      assert.equal(
        frozen[field],
        version[field],
        `delivered ${field} differs from formal version`,
      );
    const body = await docker([
      "exec",
      "--user",
      "1000",
      `antnest-runtime-${agentId}`,
      "cat",
      `/skills/${skillName}/SKILL.md`,
    ]);
    assert.equal(body, bodies.get(version.version).trim());
    assert.equal(frozen.skill_md_digest, hash(bodies.get(version.version)));
    return {
      agent_id: agentId,
      name: mount.Name,
      skill_set_digest: manifest.skill_set_digest,
      content_digest: frozen.content_digest,
      read_only: true,
    };
  };
  const verify = async (agentId, version, ready, phase) => {
    const chat = track(await context.newPage());
    try {
      await chat.goto(`${config.gateway}/workspace/${agentId}/`);
      const input = chat.getByRole("combobox", {
        name: "Message",
        exact: true,
      });
      await until(
        () => input.isEnabled(),
        "propagation composer ready",
        signal,
        45000,
      );
      await input.fill(`verify propagated preset v${version} ${phase}`);
      await chat
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      const reply = chat
        .locator(".message-assistant .message-content")
        .filter({ hasText: `Preset v${version} verified.` });
      await until(
        async () => {
          assert.equal(
            await chat.getByRole("alert", { name: "Run failed" }).count(),
            0,
            "preset Run failed in the browser",
          );
          return reply.isVisible();
        },
        "actual preset verification reply",
        signal,
        90000,
      );
      const sessionId = workspaceLocation(chat.url()).sessionId;
      assert.match(sessionId, /^session_[a-f0-9]{32}$/u);
      const run = await until(
        async () => {
          const rows = JSON.parse(
            await sql(
              `SELECT json_agg(json_build_object('run_id',r.id,'state',r.state,'stop_reason',r.stop_reason,'agent_spec_revision',r.execution_snapshot->>'agentSpecRevision','skill_instructions',r.execution_snapshot->'executionSpec'->'skillInstructions','tools',(SELECT json_agg(json_build_object('name',a.tool_name,'source',a.source,'state',a.state) ORDER BY a.started_at,a.id) FROM tool_attempts a WHERE a.run_id=r.id))) FROM runs r WHERE r.session_id='${sessionId}'`,
            ),
          );
          const value = rows?.[0];
          assert(
            !value ||
              !["failed", "cancelled", "unresolved"].includes(value.state),
          );
          return value?.state === "completed" ? value : null;
        },
        "preset read Run settled",
        signal,
        30000,
      );
      assert.equal(run.agent_spec_revision, ready.agent_spec_revision);
      assert.deepEqual(
        run.skill_instructions,
        [],
        "retired prompt delivery channel must remain empty",
      );
      assert.deepEqual(
        run.tools.map((tool) => tool.name),
        ["read"],
      );
      assert(
        run.tools.every(
          (tool) => tool.state === "completed" && tool.source === "runtime",
        ),
      );
      report.runs.push({
        agent_id: agentId,
        version,
        phase,
        session_id: sessionId,
        ...run,
      });
      await chat.screenshot({
        path: `${output}/${agentId}-preset-v${version}-${report.runs.length}.png`,
        fullPage: true,
      });
    } catch (error) {
      const diagnostic = {
        agent_id: agentId,
        phase,
        url: chat.url(),
        error: error.message,
      };
      diagnostic.runs = await sql(
        `SELECT json_agg(json_build_object('run_id',r.id,'session_id',r.session_id,'state',r.state,'error_class',r.error_class,'tools',(SELECT json_agg(json_build_object('name',a.tool_name,'state',a.state,'effect',a.tool_effect_state)) FROM tool_attempts a WHERE a.run_id=r.id))) FROM runs r JOIN acp_sessions s ON s.id=r.session_id WHERE s.agent_id='${agentId}'`,
      ).catch(() => "unavailable");
      await writeFile(
        `${output}/preset-${phase}-failure.json`,
        JSON.stringify(diagnostic),
        { mode: 0o600, flag: "wx" },
      );
      await chat
        .screenshot({
          path: `${output}/preset-${phase}-failure.png`,
          fullPage: true,
        })
        .catch(() => {});
      throw error;
    } finally {
      await chat.close();
    }
  };
  const promote = async (source, version, target) => {
    const previous = (await json("/api/admin/skills")).items.length;
    await page.goto(config.gateway + "/#skills");
    await page.getByRole("button", { name: "Discover Agent Skills" }).click();
    await page
      .getByRole("searchbox", { name: "Search Agent Skills" })
      .fill(skillName);
    const search = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/admin/skill-sources/search",
    );
    await page.getByRole("button", { name: "Find Skills" }).click();
    const found = (await (await search).json()).items.find(
      (item) => item.skill_ref.agent_id === fixture.agentID,
    );
    assert.deepEqual(found.skill_ref, source.item.skill_ref);
    assert.equal(found.content_digest, source.item.content_digest);
    const previewResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/admin/skill-sources/preview",
    );
    await page
      .getByRole("button", { name: `Review and promote ${skillName}` })
      .click();
    const response = await previewResponse;
    assert.equal(response.status(), 200);
    const preview = await response.json();
    assert.equal(preview.content_digest, source.item.content_digest);
    assert(preview.skill_md.includes(firstRule));
    assert.equal(preview.skill_md.includes(secondRule), version === 2);
    assert.equal(
      (await json("/api/admin/skills")).items.length,
      previous,
      "preview cannot copy a formal package",
    );
    bodies.set(version, preview.skill_md);
    const dialog = page.getByRole("dialog", { name: `Promote ${skillName}` });
    await dialog.locator("pre").waitFor();
    if (target)
      await dialog
        .getByRole("combobox", { name: "Publication target" })
        .selectOption(target.skill_id);
    await page.screenshot({
      path: `${output}/source-v${version}-review.png`,
      fullPage: true,
    });
    const publication = page.waitForResponse(
      (reply) =>
        new URL(reply.url()).pathname === "/api/admin/skill-sources/promote",
    );
    await dialog
      .getByRole("button", { name: "Promote Skill", exact: true })
      .click();
    const published = await publication;
    assert.equal(published.status(), 201);
    const formal = await published.json();
    assert.equal(formal.version, version);
    assert.equal(formal.content_digest, preview.content_digest);
    if (target) assert.equal(formal.skill_id, target.skill_id);
    await page
      .getByText(
        `${skillName} v${version} promoted. Add this fixed version to a Template and rebuild to apply it.`,
        { exact: true },
      )
      .waitFor();
    report.publications.push({ ...formal, source_ref: found.skill_ref });
    await checkpoint(`explicit browser promotion v${version}`);
    return formal;
  };
  const formalArtifact = async (version) => {
    const response = await request(
      `/api/admin/skills/${version.skill_id}/versions/${version.version}/artifact`,
    );
    assert.equal(response.status(), 200);
    const bytes = await response.body();
    assert.equal(bytes.length, version.artifact_size);
    assert.equal(hash(bytes), version.artifact_digest);
  };
  let v1, v2, revision1, revision2, createdId, sourceRuntime;
  const inspectSourceRuntime = async () => {
    const value = JSON.parse(
      await docker([
        "inspect",
        "--format",
        '{"id":{{json .Id}},"mounts":{{json .Mounts}}}',
        `antnest-runtime-${fixture.agentID}`,
      ]),
    );
    const workspace = value.mounts.find(
      (mount) => mount.Destination === "/workspace",
    );
    assert.equal(workspace?.Type, "volume");
    return { id: value.id, workspace: workspace.Name };
  };
  try {
    await login();
    await json("/api/admin/skill-sources/search", { query: skillName }, 403);
    const foreign = await fixture.json("/api/admin/skill-sources/search", {
      body: { query: skillName },
    });
    assert.deepEqual(
      foreign.items,
      [],
      "an organization administrator cannot impersonate another source owner",
    );
    const directory = await fixture.json("/api/admin/directory");
    const owner = directory.users.find(
      (item) => item.user.id === fixture.ownerID,
    );
    assert(owner && owner.membership.role === "member");
    await fixture.json(
      `/api/admin/directory/memberships/${owner.membership.id}`,
      {
        body: {
          email: owner.membership.email,
          display_name: owner.membership.display_name,
          role: "admin",
          active: true,
        },
      },
    );
    await login();
    await checkpoint("real Identity owner/publication permissions");
    return {
      async create(source) {
        v1 = await promote(source, 1);
        revision1 = await json(
          "/api/admin/templates",
          templateCommand(v1),
          201,
        );
        assertFrozenSkill(revision1, v1);
        const ready = await admit(
          "/api/admin/agents",
          {
            owner_user_id: fixture.ownerID,
            name: "DI1 frozen preset Agent",
            template_id: revision1.template_id,
            template_revision: revision1.revision,
          },
          "create",
        );
        createdId = ready.agent_id;
        report.initial_volume = await volume(createdId, revision1, v1);
        await verify(createdId, 1, ready, "created");
        await checkpoint("Template v1 creates a real read-only preset Runtime");
      },
      async update(source, targetId) {
        v2 = await promote(source, 2, v1);
        assert.notEqual(v1.content_digest, v2.content_digest);
        assertFrozenSkill(
          await json(
            `/api/admin/templates/${revision1.template_id}/revisions/${revision1.revision}`,
          ),
          v1,
        );
        let ready = await json(`/api/admin/agents/${createdId}`);
        await volume(createdId, revision1, v1);
        await verify(createdId, 1, ready, "frozen");
        await checkpoint(
          "publishing v2 leaves existing Template and Runtime v1 frozen",
        );
        revision2 = await json(
          `/api/admin/templates/${revision1.template_id}/revisions`,
          templateCommand(v2),
          201,
        );
        assertFrozenSkill(revision2, v2);
        assert.equal(revision2.revision, revision1.revision + 1);
        report.rebuilt_volumes = [];
        for (const agentId of [createdId, targetId]) {
          ready = await admit(
            `/api/admin/agents/${agentId}/rebuild`,
            {
              template_id: revision2.template_id,
              template_revision: revision2.revision,
            },
            "rebuild",
          );
          report.rebuilt_volumes.push(await volume(agentId, revision2, v2));
          await verify(
            agentId,
            2,
            ready,
            agentId === createdId ? "rebuilt-existing" : "rebuilt-new",
          );
        }
        assert.notEqual(
          report.rebuilt_volumes[0].name,
          report.rebuilt_volumes[1].name,
        );
        await checkpoint(
          "explicit rebuild distributes v2 to two isolated Agent volumes",
        );
        return v2;
      },
      async recordCaller(evidence) {
        report.caller = evidence;
        await checkpoint(
          "active caller excludes its own projection and loads formal and other Agent Skills",
        );
      },
      async duringRegistryOutage() {
        await json(
          "/api/admin/skill-sources/search",
          { query: skillName },
          503,
        );
        const ready = await json(`/api/admin/agents/${createdId}`);
        await volume(createdId, revision1, v1);
        await verify(createdId, 1, ready, "offline");
        await checkpoint("Registry outage does not block existing preset Runs");
      },
      async sourceLifecycle(kind, inspectSource) {
        assert(["disable", "enable", "delete"].includes(kind));
        assert(v2 && revision2 && createdId);
        if (kind === "disable") sourceRuntime = await inspectSourceRuntime();
        assert(sourceRuntime);
        const accepted = await json(
          `/api/admin/agents/${fixture.agentID}/${kind}`,
          {},
          202,
        );
        const operation = accepted.operation ?? accepted;
        await fixture.operation(operation.request_id);
        let state = await json(`/api/admin/agents/${fixture.agentID}`);
        if (kind === "enable") {
          state = await waitForAgentReady(
            () => json(`/api/admin/agents/${fixture.agentID}`),
            signal,
          );
          const runtime = await inspectSourceRuntime();
          assert.notEqual(runtime.id, sourceRuntime.id);
          assert.equal(runtime.workspace, sourceRuntime.workspace);
        } else {
          if (kind === "disable") assertAgentDisabled(state);
          else assertAgentDeleted(state);
          assert.equal(
            await docker([
              "ps",
              "-aq",
              "--filter",
              `name=^/antnest-runtime-${fixture.agentID}$`,
            ]),
            "",
          );
          const volumes = (await docker(["volume", "ls", "-q"]))
            .split(/\s+/u)
            .filter(Boolean);
          assert.equal(
            volumes.includes(sourceRuntime.workspace),
            kind === "disable",
          );
        }
        const phase = {
          disable: "disabled",
          enable: "enabled",
          delete: "deleted",
        }[kind];
        const source = await inspectSource(phase);
        if (kind === "delete") {
          await until(
            async () =>
              (await sql(
                `SELECT sequence || '|' || sent_sequence FROM skill_source_projections WHERE agent_id='${fixture.agentID}' AND NOT active`,
              )) === "3|3",
            "deleted Agent source tombstone delivered without model replay",
            signal,
            90000,
          );
        } else {
          assert.equal(
            await sql(
              `SELECT sequence FROM skill_source_projections WHERE agent_id='${fixture.agentID}' AND active`,
            ),
            "2",
          );
        }
        await formalArtifact(v1);
        await formalArtifact(v2);
        const ready = await json(`/api/admin/agents/${createdId}`);
        await volume(createdId, revision2, v2);
        if (kind !== "enable")
          await verify(createdId, 2, ready, `source-${phase}`);
        (report.source_lifecycle ??= []).push({
          kind,
          request_id: operation.request_id,
          lifecycle_state: state.lifecycle_state,
          activation_state: state.activation_state,
          runtime_state: state.runtime_state,
          source,
        });
        await checkpoint(
          {
            disable:
              "normal source Disable rejects reads while formal presets remain executable",
            enable:
              "normal source Enable restores unchanged identity on a new Runtime",
            delete:
              "normal source Delete rejects old refs, sends a tombstone and preserves formal versions",
          }[kind],
        );
      },
      async afterRemoval() {
        const search = await json("/api/admin/skill-sources/search", {
          query: skillName,
        });
        assert.deepEqual(search.items, []);
        await formalArtifact(v1);
        await formalArtifact(v2);
        assertFrozenSkill(
          await json(
            `/api/admin/templates/${revision1.template_id}/revisions/${revision1.revision}`,
          ),
          v1,
        );
        const ready = await json(`/api/admin/agents/${createdId}`);
        await volume(createdId, revision2, v2);
        await verify(createdId, 2, ready, "independent");
        await checkpoint(
          "source removal preserves immutable versions and distributed presets",
        );
        const traces = [];
        for (const run of report.runs) {
          const trace = await until(
            async () => {
              const found = await searchJaegerTraces(
                config.jaeger,
                new URLSearchParams({
                  service: "agent-acp-service",
                  operation: "agent.run",
                  tags: JSON.stringify({ "antnest.run.id": run.run_id }),
                  lookback: "30m",
                  limit: "20",
                }),
                {
                  signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
                },
              );
              assert(found.length <= 1);
              if (!found[0]) return null;
              try {
                traceTopology(found[0]);
              } catch {
                return null;
              }
              return found[0].spans.some(
                (span) => span.operationName === "model.complete",
              ) &&
                found[0].spans.some(
                  (span) => span.operationName === "mcp.tools.call",
                )
                ? found[0]
                : null;
            },
            "exported preset Run Trace with complete parents",
            signal,
            45000,
          );
          assertCaptureDisabled(trace);
          assert(!JSON.stringify(trace).includes(firstRule));
          const root = trace.spans.find(
            (span) => span.operationName === "agent.run",
          );
          assert.equal(tag(root, "antnest.run.id"), run.run_id);
          traces.push(trace);
          run.trace_id = trace.traceID;
        }
        await writeFile(
          `${output}/preset-traces.json`,
          JSON.stringify(traces),
          { mode: 0o600, flag: "wx" },
        );
        assert.deepEqual(errors, []);
        await checkpoint("preset Run Trace topology and zero browser errors");
        const model = await docker([
          "ps",
          "-q",
          "--filter",
          `label=com.docker.compose.project=${config.project}`,
          "--filter",
          "label=com.docker.compose.service=stage3-model",
        ]);
        assert.match(model, /^[a-f0-9]{12,64}$/u);
        report.model_status = JSON.parse(
          await docker([
            "exec",
            model,
            "node",
            "-e",
            "fetch('http://127.0.0.1:8080/status').then(r=>r.text()).then(console.log)",
          ]),
        );
        assert.deepEqual(
          report.model_status.errors,
          [],
          "the deterministic provider must not conceal rejected requests",
        );
        assert.deepEqual(report.model_status.pending, []);
        report.template_id = revision1.template_id;
        report.template_revisions = [revision1.revision, revision2.revision];
        report.status = "passed";
        await writeFile(`${output}/result.json`, JSON.stringify(report), {
          mode: 0o600,
          flag: "wx",
        });
        return report;
      },
      async close() {
        signal.removeEventListener("abort", abort);
        await close();
      },
      async captureFailure(error) {
        report.status = "failed";
        report.error = { name: error.name, message: error.message };
        report.browser_errors = errors;
        await writeFile(`${output}/failure.json`, JSON.stringify(report), {
          mode: 0o600,
          flag: "wx",
        });
        if (!page.isClosed())
          await page
            .screenshot({ path: `${output}/failure.png`, fullPage: true })
            .catch(() => {});
      },
    };
  } catch (error) {
    signal.removeEventListener("abort", abort);
    await close();
    throw error;
  }
}
