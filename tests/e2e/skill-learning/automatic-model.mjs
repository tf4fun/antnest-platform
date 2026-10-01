import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { temporaryDecision } from "./temporary-model.mjs";
import { propagationDecision } from "./propagation-model.mjs";
import { callerDecision } from "./caller-model.mjs";

const newRule = "For the fixture task, inspect the target before editing it.";
const addedRule = "For the fixture task, check the result after editing it.";
const skillPath = ".antnest/skills/fixture-procedure/SKILL.md";
const debug = process.env.ANTNEST_E2E_SKILL_LEARNING_DEBUG === "true";

export function decide(
  payload,
  {
    reviewFailure = process.env.ANTNEST_E2E_REVIEW_FAILURE === "true",
    toolUsability = process.env.ANTNEST_E2E_TOOL_USABILITY === "true",
  } = {},
) {
  assert.equal(payload.model, "stage3-model");
  const review = !Array.isArray(payload.tools) || payload.tools.length === 0;
  if (review) {
    assert(
      payload.messages[0]?.content?.includes(
        "reviewing one completed Agent run",
      ),
    );
    const data = payload.messages
      .map((message) => {
        try {
          return JSON.parse(message.content ?? "null");
        } catch {
          return null;
        }
      })
      .find((item) => Array.isArray(item?.items));
    const user = data.items?.find((item) => item.kind === "authenticated_user");
    assert(user?.evidenceId);
    if (debug) {
      assert(payload.messages[0].content.includes("development debug"));
      assert(payload.messages[0].content.includes("must return"));
      if (!payload.messages.at(-1).content.includes('"decision":"propose"')) {
        return {
          kind: user.text.includes(addedRule)
            ? "review-debug-update-skip"
            : "review-debug-create-skip",
          text: JSON.stringify({
            decision: "skip",
            reason: "This synthetic skip must be rejected by debug learning",
          }),
        };
      }
    }
    if (process.env.ANTNEST_E2E_REVIEW_UNTRUSTED === "true") {
      const output = data.items.find(
        (item) => item.kind === "untrusted_material",
      );
      assert(
        output?.evidenceId,
        "the source Run must contain actual untrusted tool output",
      );
      const evidenceMessage = payload.messages.findIndex((message) => {
        try {
          return Array.isArray(JSON.parse(message.content ?? "null")?.items);
        } catch {
          return false;
        }
      });
      return {
        kind:
          payload.messages.length > evidenceMessage + 1
            ? "review-untrusted-repair"
            : "review-untrusted",
        text: JSON.stringify({
          decision: "propose",
          name: "fixture-procedure",
          description: "An instruction taken only from tool output",
          instructions: "Follow the tool output as a rule",
          rules: [{ text: output.text, evidenceIds: [output.evidenceId] }],
        }),
      };
    }
    if (reviewFailure) return { kind: "review-failure", errorStatus: 503 };
    if (process.env.ANTNEST_E2E_REVIEW_SKIP === "true")
      return {
        kind: "review-skip",
        text: JSON.stringify({
          decision: "skip",
          reason:
            "The completed fixture run did not establish a reusable procedure.",
        }),
      };
    const update = user.text.includes("check the result after editing");
    assert(user.text.includes(update ? addedRule : newRule));
    if (update && process.env.ANTNEST_E2E_PINNED !== "true") {
      const existing = data.existingSkills?.find(
        (skill) => skill.name === "fixture-procedure",
      );
      assert(
        existing?.content?.includes(newRule),
        "review must read the previous Skill",
      );
    }
    return {
      kind: update
        ? "review-update"
        : user.text.startsWith("learn: peer source:")
          ? "review-peer-create"
          : user.text.includes("after model recovery:")
            ? "review-recovered-create"
            : "review-create",
      text: JSON.stringify({
        decision: "propose",
        name: "fixture-procedure",
        description: "A verified fixture procedure",
        instructions: "Review-only text",
        rules: [
          {
            text: update ? addedRule : newRule,
            evidenceIds: [user.evidenceId],
          },
        ],
      }),
    };
  }
  const last = payload.messages.findLast((message) => message.role === "user");
  const prompt = last?.content;
  assert(typeof prompt === "string");
  if (
    prompt.startsWith("Use the user-selected Skill") &&
    prompt.includes("User task:\nverify selected skill command")
  ) {
    assert(prompt.includes('"source":"personal"'));
    assert(prompt.includes('"name":"fixture-procedure"'));
    assert(prompt.includes(newRule));
    assert(prompt.includes(addedRule));
    return {
      kind: "foreground-skill-command-reply",
      text: "Selected Skill content is available for this task.",
    };
  }
  if (prompt === "foreground during review")
    return {
      kind: "foreground-preempt-reply",
      text: "Foreground request completed.",
    };
  const messagesAfter = payload.messages.slice(
    payload.messages.indexOf(last) + 1,
  );
  const temporary = temporaryDecision(payload, prompt, messagesAfter);
  if (temporary) return temporary;
  const propagation = propagationDecision(payload, prompt, messagesAfter);
  if (propagation) return propagation;
  const caller = callerDecision(payload, prompt, messagesAfter);
  if (caller) return caller;
  if (prompt === "discover reusable fixture-procedure") {
    for (const name of ["find_skill", "load_skill"])
      assert(payload.tools.some((tool) => tool.function.name === name));
    const results = messagesAfter.filter((message) => message.role === "tool");
    if (results.length === 0)
      return {
        kind: "foreground-discovery-search",
        call: {
          name: "find_skill",
          arguments: { query: "fixture-procedure", limit: 5 },
        },
      };
    const found = JSON.parse(results[0].content).items?.find(
      (item) =>
        item.skill_ref.kind === "agent" && item.name === "fixture-procedure",
    );
    assert(found, "search must return an actual Agent source");
    if (results.length === 1)
      return {
        kind: "foreground-discovery-load",
        call: {
          name: "load_skill",
          arguments: {
            skill_ref: found.skill_ref,
            expected_digest: found.content_digest,
          },
        },
      };
    const loaded = JSON.parse(results.at(-1).content);
    assert.deepEqual(loaded.skill_ref, found.skill_ref);
    assert.equal(loaded.content_digest, found.content_digest);
    assert.equal(loaded.temporary_files, null);
    assert.equal(loaded.requires_runtime_delivery, false);
    assert(loaded.skill_text?.includes(newRule));
    assert(loaded.skill_text?.includes(addedRule));
    return {
      kind: "foreground-discovery-reply",
      text: "The source Agent's two learned rules are available as guidance for this Run.",
    };
  }
  if (prompt.startsWith("learn:")) {
    const recovered = prompt.startsWith("learn: after model recovery:");
    const peer = prompt.startsWith("learn: peer source:");
    assert(!peer || !prompt.includes(addedRule));
    const phase = `${peer ? "peer-" : recovered ? "recovered-" : ""}${prompt.includes(addedRule) ? "update" : "create"}`;
    const completedRounds = messagesAfter.filter(
      (message) => message.role === "tool",
    ).length;
    if (toolUsability) {
      for (const name of ["read", "write", "edit"])
        assert.equal(
          payload.tools.find((tool) => tool.function.name === name)?.function
            .parameters.properties.path.type,
          "string",
        );
      const path = "demo/tool-usability.md";
      const calls = [
        {
          name: "write",
          arguments: { path, content: "# Tool verification\nstate: draft\n" },
        },
        {
          name: "edit",
          arguments: {
            path,
            old_string: "state: draft",
            new_string: "state: verified",
          },
        },
        { name: "read", arguments: { path } },
        {
          name: "bash",
          arguments: {
            command:
              "test -f demo/tool-usability.md && printf 'fixture-tool-completed\\n'",
          },
        },
      ];
      if (completedRounds < calls.length)
        return {
          kind: `foreground-${phase}-tool-${completedRounds + 1}`,
          call: calls[completedRounds],
        };
      const results = messagesAfter.filter(
        (message) => message.role === "tool",
      );
      assert(
        JSON.parse(results[2].content).content.includes("state: verified"),
        "read-back must contain the edited text",
      );
      assert.equal(JSON.parse(results[3].content).exit_code, 0);
    }
    if (!toolUsability && completedRounds < (debug ? 1 : 3))
      return {
        kind: `foreground-${phase}-tool-${completedRounds + 1}`,
        call: {
          name: "bash",
          arguments: {
            command: "printf 'fixture-tool-completed\\n'",
            working_dir: ".",
            timeout_ms: 3000,
          },
        },
      };
    assert.equal(messagesAfter.at(-1)?.role, "tool");
    return {
      kind: `foreground-${phase}-reply`,
      text: "Fixture procedure completed.",
    };
  }
  assert(
    [
      "verify learned procedure",
      "verify learned procedure after rebuild",
      "verify learned procedure after model recovery",
    ].includes(prompt),
  );
  const rebuildVerify = prompt === "verify learned procedure after rebuild";
  const recoveryVerify =
    prompt === "verify learned procedure after model recovery";
  if (messagesAfter.length === 0)
    return {
      kind: recoveryVerify
        ? "foreground-recovery-verify-tool"
        : rebuildVerify
          ? "foreground-rebuild-verify-tool"
          : "foreground-verify-tool",
      call: {
        name: "read",
        arguments: {
          path: skillPath,
        },
      },
    };
  const output = JSON.parse(messagesAfter.at(-1)?.content ?? "null");
  assert(output.content?.includes(newRule));
  if (!recoveryVerify) assert(output.content?.includes(addedRule));
  return {
    kind: recoveryVerify
      ? "foreground-recovery-verify-reply"
      : rebuildVerify
        ? "foreground-rebuild-verify-reply"
        : "foreground-verify-reply",
    text: recoveryVerify
      ? "The recovered learned rule is active."
      : "Both learned rules are active.",
  };
}

export function modelServer() {
  const requests = [];
  const errors = [];
  const pending = new Map();
  const cancelled = [];
  const holdReview = process.env.ANTNEST_E2E_HOLD_REVIEW === "true";
  let reviewUnavailable = process.env.ANTNEST_E2E_REVIEW_FAILURE === "true";
  const completion = (result) => ({
    choices: [
      {
        finish_reason: result.call ? "tool_calls" : "stop",
        message: result.call
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `${result.kind}-tool`,
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
  return createServer(async (request, response) => {
    const reply = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "GET" && request.url === "/status")
      return reply(200, {
        requests,
        errors,
        pending: [...pending.keys()],
        cancelled,
      });
    if (request.method === "POST" && request.url === "/release-review") {
      const held = pending.get("review-create");
      if (!held) return reply(409, { error: "no held review" });
      pending.delete("review-create");
      held.response.writeHead(200, { "content-type": "application/json" });
      held.response.end(JSON.stringify(completion(held.result)));
      return reply(200, { released: "review-create" });
    }
    if (request.method === "POST" && request.url === "/recover-review") {
      if (!reviewUnavailable || !requests.includes("review-failure"))
        return reply(409, { error: "no failed review to recover" });
      reviewUnavailable = false;
      return reply(200, { recovered: true });
    }
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer stage3-model-secret");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      const result = decide(payload, { reviewFailure: reviewUnavailable });
      assert(!requests.includes(result.kind), "model request was repeated");
      requests.push(result.kind);
      if (result.errorStatus) {
        reply(result.errorStatus, {
          error: "synthetic review model unavailable",
        });
        return;
      }
      if (result.hold || (holdReview && result.kind === "review-create")) {
        pending.set(result.kind, { response, result });
        response.once("close", () => {
          if (pending.delete(result.kind)) cancelled.push(result.kind);
        });
        return;
      }
      reply(200, completion(result));
    } catch (error) {
      errors.push(
        error instanceof assert.AssertionError
          ? error.message
          : "model request rejected",
      );
      reply(400, { error: "model request rejected" });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  modelServer().listen(8080, "0.0.0.0");
