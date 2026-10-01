import assert from "node:assert/strict";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";

export const phases = [
  "v1-baseline",
  "v2-baseline",
  "http-baseline",
  ...(process.env.ANTNEST_E2E_SKILL_REGISTRY_OUTAGE === "true"
    ? ["registry-outage"]
    : []),
  ...(process.env.ANTNEST_E2E_SKILL_OFFLINE_REUSE === "true"
    ? ["offline-reuse"]
    : []),
  "after-rebuild",
];
const skillMode = process.env.ANTNEST_E2E_SKILL_DELIVERY === "true";
const skillBody = (version) =>
  `---\nname: code-review\ndescription: Review code\n---\nStage 4 immutable preset version ${version}.\n`;
export function registryDenialCommand(ip) {
  assert.equal(isIP(ip), 4, "Registry network probe needs its actual IPv4");
  const name = "http://skill-registry:8080/status";
  const curl =
    "curl --noproxy '*' -fsS --connect-timeout 1 --max-time 2 -o /dev/null";
  return [
    "curl --version >/dev/null || exit 43",
    `route=$(ip -4 route get ${ip} uid 1000) || exit 46`,
    'case " $route " in *" dev antnest0 "*) ;; *) exit 47 ;; esac',
    `if ${curl} ${name} >/dev/null 2>&1; then exit 44; fi`,
    "printf 'registry-dns-blocked\\n'",
    `if ${curl} --resolve skill-registry:8080:${ip} ${name} >/dev/null 2>&1; then exit 45; fi`,
    "printf 'registry-ip-blocked\\n'",
  ].join("; ");
}
export function decide(payload) {
  const last = payload.messages.findLastIndex((m) => m.role === "user");
  const phase = payload.messages[last]?.content;
  assert(phases.includes(phase), "unexpected fixture phase");
  assert.equal(payload.model, "stage3-model", "API model identity changed");
  assert.equal(
    payload.max_tokens,
    phase === phases[0] ? 1024 : 2048,
    "current Model parameters were not applied",
  );
  const results = payload.messages
    .slice(last + 1)
    .filter((m) => m.role === "tool");
  assert(results.length <= 1, "duplicate Tool result");
  if (results.length) {
    const result = JSON.parse(results[0].content);
    assert.equal(result.exit_code, 0);
    assert.equal(result.effect_state, "settled");
    assert.equal(result.stderr, "");
    assert.equal(result.truncated, false);
    const skillRead =
      skillMode &&
      [
        "v1-baseline",
        "registry-outage",
        "offline-reuse",
        "after-rebuild",
      ].includes(phase);
    const expected =
      phases.slice(0, phases.indexOf(phase) + 1).join("\n") +
      "\n" +
      (skillRead ? skillBody(phase === "after-rebuild" ? 2 : 1) : "") +
      (skillMode && phase === "v1-baseline"
        ? "registry-dns-blocked\nregistry-ip-blocked\n"
        : "");
    assert.equal(
      result.stdout,
      expected,
      "persisted effects or preset Skill mismatch",
    );
    return {
      phase,
      text: `${phase} verified`,
      ...(skillMode && phase === "v1-baseline"
        ? { registryNetworkDenied: true }
        : {}),
    };
  }
  assert(
    payload.tools.some((t) => t.function.name === "bash"),
    "Bash missing",
  );
  return {
    phase,
    call: {
      name: "bash",
      arguments: {
        command: `printf '%s\\n' '${phase}' >> /workspace/stage3-effects.log; cat /workspace/stage3-effects.log${skillMode && ["v1-baseline", "registry-outage", "offline-reuse", "after-rebuild"].includes(phase) ? "; cat /skills/code-review/SKILL.md" : ""}${skillMode && phase === "v1-baseline" ? "; " + registryDenialCommand(process.env.ANTNEST_E2E_REGISTRY_IP) : ""}`,
        working_dir: ".",
        timeout_ms: 10000,
      },
    },
  };
}
export function modelServer() {
  const requests = [],
    errors = [];
  return createServer(async (request, response) => {
    const reply = (status, data) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(data));
    };
    if (request.method === "GET" && request.url === "/status")
      return reply(200, { requests, errors });
    try {
      assert(
        request.method === "POST" && request.url === "/v1/chat/completions",
        "unexpected route",
      );
      assert.match(
        request.headers.traceparent ?? "",
        /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/,
      );
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        assert(size <= 1024 * 1024, "request too large");
        chunks.push(chunk);
      }
      const result = decide(JSON.parse(Buffer.concat(chunks).toString()));
      const key =
        result.phase === phases[0]
          ? "stage3-initial-key"
          : "stage3-rotated-key";
      assert(
        request.headers.authorization === `Bearer ${key}`,
        "wrong credential generation",
      );
      const stage = result.call ? "tool" : "reply";
      assert(
        !requests.some((r) => r.phase === result.phase && r.stage === stage),
        "duplicate model request",
      );
      requests.push({
        phase: result.phase,
        stage,
        trace_id: request.headers.traceparent.split("-")[1],
        model_span_id: request.headers.traceparent.split("-")[2],
        ...(result.registryNetworkDenied
          ? { registry_network_denied: true }
          : {}),
      });
      reply(200, {
        choices: [
          {
            finish_reason: result.call ? "tool_calls" : "stop",
            message: result.call
              ? {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: `${result.phase}-tool`,
                      type: "function",
                      function: {
                        name: result.call.name,
                        arguments: JSON.stringify(result.call.arguments),
                      },
                    },
                  ],
                }
              : { role: "assistant", content: result.text },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      });
    } catch {
      // Never include request bodies, headers or assertion actual/expected values.
      errors.push("fixture request rejected");
      reply(400, { error: "fixture request rejected" });
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  modelServer().listen(8080, "0.0.0.0");
