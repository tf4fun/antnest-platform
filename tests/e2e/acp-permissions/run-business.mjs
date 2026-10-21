import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  assertAdmissionError,
  assertErrorCapability,
} from "../../support/acp-errors.mjs";
import { verifyModelRequests } from "./expectations.mjs";
import { decide } from "./model.mjs";

const invalid = "Permissions business evidence is invalid";
const groups = [
  ["once", "once-again", "deny", "always", "follow"],
  ["reject", "reject-follow"],
  ["chat"],
  ["read-hint", "judge-safe", "judge-ask"],
  ["cancel"],
  ["reconnect"],
];
const entries = groups.flat();
const decisions = {
  once: "allow_once",
  "once-again": "allow_once",
  deny: "reject_once",
  always: "allow_always",
  reject: "reject_always",
  "judge-ask": "allow_once",
  cancel: "cancelled",
  reconnect: "allow_once",
};
const options = ["allow_once", "allow_always", "reject_once", "reject_always"];
const summaryFields = [
  "run_id",
  "agent_id",
  "session_id",
  "principal_id",
  "state",
  "created_at",
  "updated_at",
];
const requestFields = [
  "boundary",
  "transport",
  "protocolVersion",
  "agentId",
  "requestId",
  "method",
  "inputSessionID",
  "sessionId",
  "requestParams",
  "requestReceipt",
  "outcome",
  "closedBeforeResponse",
  "rejection",
  "rejectionReceipt",
];
const deliveryFields = ["requestId", "params", "outcome", "optionId"];
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const require = (condition) => {
  if (!condition) throw new Error(invalid);
};
const same = (actual, expected) => require(isDeepStrictEqual(actual, expected));
const id = (value) =>
  require(typeof value === "string" && value.length > 0 && value.length <= 200);
const list = (value) => {
  require(Array.isArray(value));
  return value;
};
const date = (value) =>
  require(typeof value === "string" && Number.isFinite(Date.parse(value)));
const fieldsEqual = (a, b, keys) =>
  keys.every((key) => isDeepStrictEqual(a?.[key], b?.[key]));
const one = (values) => {
  require(values.length === 1);
  return values[0];
};

function page(value, stream) {
  require(object(value));
  require(list(value.items).length <= 100 && value.next_cursor === null);
  if (stream) require(value.stream === stream);
  return value.items;
}

function responses(connection, requestId) {
  return connection.raw_frames.filter(
    (frame) =>
      object(frame) &&
      Object.hasOwn(frame, "id") &&
      String(frame.id) === requestId &&
      (Object.hasOwn(frame, "result") || Object.hasOwn(frame, "error")),
  );
}

function checkConnections(input) {
  require(list(input.connections).length === 6);
  const connections = [];
  for (const version of [1, 2]) {
    for (const role of ["foreign", "owner", "replay"]) {
      const c = one(
        input.connections.filter(
          (row) => row.version === version && row.role === role,
        ),
      );
      require(c.agentId === input.agent_ids[version - 1]);
      list(c.evidence);
      list(c.requests);
      list(c.raw_frames);
      list(c.permissions);
      list(c.notifications);
      const rows = [c.initialization, ...c.evidence];
      require(rows.every(object));
      require(new Set(rows.map((row) => row.requestId)).size === rows.length);
      same(
        c.requests.map((row) => [
          row.requestId,
          row.method,
          row.sessionId ?? null,
        ]),
        rows.map((row) => [row.requestId, row.method, row.inputSessionID]),
      );
      for (const row of rows) {
        id(row.requestId);
        require(
          row.boundary === "private-acp" && row.transport === "websocket",
        );
        require(row.protocolVersion === version && row.agentId === c.agentId);
      }
      const initialized = c.initialization;
      require(
        initialized.method === "initialize" &&
          initialized.outcome === "succeeded",
      );
      require(
        initialized.inputSessionID === null &&
          initialized.sessionId === undefined,
      );
      require(initialized.initializationResult?.protocolVersion === version);
      assertErrorCapability(initialized.initializationResult);
      const raw = one(responses(c, initialized.requestId));
      require(!Object.hasOwn(raw, "error"));
      same(raw.result, initialized.initializationResult);
      const permissions = c.raw_frames.filter(
        (frame) => frame.method === "session/request_permission",
      );
      same(
        permissions.map((frame) => [String(frame.id), frame.params]),
        c.permissions.map((row) => [row.requestId, row.params]),
      );
      require(
        new Set(c.permissions.map((row) => row.requestId)).size ===
          c.permissions.length,
      );
      if (role === "foreign") {
        require(c.permissions.length === 0 && c.notifications.length === 0);
        require(
          !c.raw_frames.some((frame) => frame.method === "session/update"),
        );
      }
      connections.push(c);
    }
  }
  return connections;
}

function checkRequests(input, connections) {
  const inventory = input.inventory;
  require(object(inventory));
  require(
    list(inventory.requests).length === 56 &&
      list(inventory.initializations).length === 6,
  );
  require(
    list(inventory.permissions).length === 18 &&
      list(inventory.notifications).length === 2,
  );
  for (const c of connections) {
    const initialized = one(
      inventory.initializations.filter(
        (row) =>
          row.label === `v${c.version}:${c.role}:initialize` &&
          row.version === c.version &&
          fieldsEqual(row, c.initialization, requestFields),
      ),
    );
    same(
      initialized.initializationResult,
      c.initialization.initializationResult,
    );
  }
  const used = new Set(),
    originals = new Map(),
    sessions = new Set();
  for (const request of inventory.requests) {
    require(object(request));
    const matches = connections.flatMap((connection) =>
      connection.evidence
        .filter((row) => fieldsEqual(request, row, requestFields))
        .map((row) => ({ connection, row })),
    );
    const source = one(matches),
      { connection: c, row } = source;
    require(request.version === c.version && !used.has(row));
    used.add(row);
    require(row.inputSessionID === (row.requestParams?.sessionId ?? null));
    if (row.method === "session/new" && row.outcome === "succeeded") {
      id(row.sessionId);
      require(!sessions.has(row.sessionId));
      sessions.add(row.sessionId);
    }
    const raw = responses(c, row.requestId);
    const closed =
      row.method === "session/prompt" &&
      c.version === 1 &&
      row.requestParams?.prompt?.[0]?.text === "v1-reconnect";
    if (closed) {
      require(row.outcome === "failed" && row.closedBeforeResponse === true);
      require(row.requestReceipt === undefined && raw.length === 0);
    } else if (row.rejection) {
      require(c.role === "foreign" && row.rejection === "access_denied");
      require(row.outcome === "rejected" && row.requestReceipt === undefined);
      assertAdmissionError(one(raw).error, "access_denied");
    } else {
      require(row.outcome === "succeeded" && object(row.requestReceipt));
      require(row.requestReceipt.requestId === row.requestId);
      same(row.requestReceipt.params, row.requestParams);
      const response = one(raw);
      require(!Object.hasOwn(response, "error"));
      same(response.result, row.requestReceipt.result);
    }
    if (row.method !== "session/prompt") continue;
    require(c.role === "owner" && request.kind === "execution");
    const phase = request.phase,
      entry = typeof phase === "string" ? phase.slice(3) : undefined;
    require(entries.includes(entry) && phase === `v${c.version}-${entry}`);
    require(!originals.has(phase));
    same(row.requestParams.prompt, [{ type: "text", text: phase }]);
    require(row.sessionId === row.requestParams.sessionId);
    originals.set(phase, {
      request,
      source: row,
      connection: c,
      phase,
      entry,
      version: c.version,
    });
  }
  require(
    used.size ===
      connections.reduce((count, c) => count + c.evidence.length, 0),
  );
  require(sessions.size === 12 && originals.size === 26);
  for (const version of [1, 2]) {
    const distinct = new Set();
    for (const group of groups) {
      const ids = group.map(
        (entry) => originals.get(`v${version}-${entry}`)?.request.sessionId,
      );
      require(
        ids.every((value) => sessions.has(value)) && new Set(ids).size === 1,
      );
      require(!distinct.has(ids[0]));
      distinct.add(ids[0]);
    }
  }
  return originals;
}

function checkEvents(record, eventIds, sequences) {
  const events = page(record.events, "execution"),
    run = record.run;
  let previous = 0;
  for (const event of events) {
    id(event.id);
    date(event.created_at);
    require(!eventIds.has(event.id));
    eventIds.add(event.id);
    require(
      Number.isSafeInteger(event.sequence) &&
        event.sequence > previous &&
        !sequences.has(event.sequence),
    );
    previous = event.sequence;
    sequences.add(event.sequence);
    require(
      typeof event.visible === "boolean" &&
        object(event.payload) &&
        event.kind === event.payload.kind,
    );
    if (
      ["user_message", "agent_message", "agent_thought"].includes(event.kind)
    ) {
      require(event.payload.messageId === event.id);
      list(event.payload.content);
    }
  }
  const user = one(events.filter((event) => event.kind === "user_message"));
  require(user.visible === true);
  same(user.payload.content, run.input);
  const measurements = events
    .filter((event) => event.kind === "usage")
    .map((event) => event.payload.measurement);
  same(run.usage_measurements, measurements);
  return { events, user, measurements };
}

function checkRun(record, original, eventIds, sequences, input, ready) {
  const run = record.run,
    { entry, phase, version, request } = original;
  require(
    run.agent_id === request.agentId && run.session_id === request.sessionId,
  );
  require(
    run.principal_id === input.principal_id &&
      run.principal_id === ready.owner_user_id,
  );
  same(run.input, request.requestParams.prompt);
  const cancelled = entry === "cancel",
    chat = entry === "chat";
  const executes =
    !chat && !cancelled && !["deny", "reject", "reject-follow"].includes(entry);
  require(
    run.state === (cancelled ? "cancelled" : "completed") &&
      run.terminal_class === run.state,
  );
  require(
    run.executor_state === "quiescent" &&
      run.tool_effect_state === (executes ? "settled" : "none"),
  );
  require(
    run.unknown_effect_source === null ||
      run.unknown_effect_source === undefined,
  );
  require(
    run.stop_reason === (cancelled ? null : "end_turn") &&
      run.error_class === null,
  );
  const snapshot = run.execution_snapshot;
  require(object(snapshot));
  id(snapshot.providerConnectionId);
  id(snapshot.modelProfileId);
  id(snapshot.agentSpecRevision);
  id(snapshot.executionRevision);
  require(
    Number.isSafeInteger(snapshot.configurationRevision) &&
      snapshot.configurationRevision > 0,
  );
  same(snapshot.agentSpecRevision, ready.agent_spec_revision);
  same(snapshot.executionRevision, ready.executable_execution_revision);
  const selected = original.connection.evidence.find(
    (row) =>
      row.method === "session/set_config_option" &&
      row.sessionId === run.session_id &&
      row.requestParams.configId === "model",
  );
  if (selected) {
    require(
      typeof selected.requestParams.value === "string" &&
        selected.requestParams.value.startsWith("profile:"),
    );
    require(snapshot.modelProfileId === selected.requestParams.value.slice(8));
  }
  const facts = checkEvents(record, eventIds, sequences);
  if (version === 2)
    require(
      request.requestReceipt.result.messageId === facts.user.payload.messageId,
    );
  else if (entry !== "reconnect")
    same(request.requestReceipt.result, {
      stopReason: cancelled ? "cancelled" : "end_turn",
    });
  const modelRequests = input.model_requests.filter(
    (row) => row.phase === phase,
  );
  require(facts.measurements.length === modelRequests.length);
  const replies = facts.events.filter(
    (event) => event.kind === "agent_message" && event.visible,
  );
  const reply = replies.flatMap((event) => event.payload.content);
  if (cancelled) require(reply.length === 0);
  else {
    require(
      reply.every(
        (block) => block.type === "text" && typeof block.text === "string",
      ),
    );
    require(reply.map((block) => block.text).join("") === `${phase} verified`);
  }
  require(!facts.events.some((event) => event.kind === "agent_thought"));
  const toolId = createHash("sha256")
    .update(JSON.stringify([run.run_id, 0, phase]))
    .digest("hex");
  const name = entry.startsWith("judge-")
    ? "mcp__fixture__echo"
    : entry === "read-hint"
      ? "read"
      : "write";
  const arguments_ =
    name === "mcp__fixture__echo"
      ? { value: phase }
      : name === "read"
        ? { path: phase.slice(0, 2) + "-once.txt", limit: 1024 }
        : { path: `${phase}.txt`, content: `${phase}\n` };
  const calls = facts.events
    .filter((event) => event.kind === "agent_message")
    .flatMap((event) => event.payload.toolCalls ?? []);
  same(calls, chat ? [] : [{ id: toolId, name, arguments: arguments_ }]);
  const tools = facts.events.filter((event) => event.kind === "tool_call");
  if (chat) require(tools.length === 0);
  else {
    const started = one(
      tools.filter((event) => event.payload.initial === true),
    );
    require(
      started.payload.toolCallId === toolId &&
        started.payload.modelName === name,
    );
    same(started.payload.arguments, arguments_);
    for (const event of tools)
      require(
        event.payload.toolCallId === toolId &&
          typeof event.payload.initial === "boolean",
      );
    if (executes) {
      require(started.payload.status === "in_progress");
      const finished = one(
        tools.filter(
          (event) =>
            event.payload.initial === false &&
            event.payload.status === "completed",
        ),
      );
      require(finished.sequence > started.sequence);
      for (const event of tools) {
        if (event === started || event === finished) continue;
        require(
          event.payload.initial === false &&
            event.payload.status === "in_progress",
        );
        require(
          event.sequence > started.sequence &&
            event.sequence < finished.sequence,
        );
      }
      const content = list(finished.payload.content);
      const text = content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      require(
        decide({
          messages: [
            { role: "user", content: phase },
            { role: "tool", content: text },
          ],
        }).text === `${phase} verified`,
      );
    } else {
      require(tools.length === 1 && started.payload.status === "failed");
      const text = list(started.payload.content)
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (!cancelled)
        require(
          decide({
            messages: [
              { role: "user", content: phase },
              { role: "tool", content: text },
            ],
          }).text === `${phase} verified`,
        );
      else require(text.includes("Tool was not executed"));
    }
  }
  return {
    ...original,
    ...facts,
    record,
    run,
    executes,
    cancelled,
    chat,
    toolId,
    name,
    arguments: arguments_,
  };
}

function checkPermissions(info, input) {
  const rows = page(info.record.permissions, "permissions"),
    decision = decisions[info.entry];
  require(rows.length === (decision === undefined ? 0 : 1));
  const deliveries = input.connections.flatMap((connection) =>
    connection.permissions
      .filter(
        (row) =>
          (row.params.toolCall ?? row.params.subject?.toolCall)?.toolCallId ===
          info.toolId,
      )
      .map((row) => ({ connection, row })),
  );
  const expectedCount =
    decision === undefined ? 0 : info.entry === "reconnect" ? 2 : 1;
  require(deliveries.length === expectedCount);
  const indexed = info.request.permissionDeliveries ?? [];
  require(indexed.length === expectedCount);
  const used = new Set();
  for (const indexedRow of indexed) {
    const match = one(
      deliveries.filter(({ row }) =>
        fieldsEqual(row, indexedRow, deliveryFields),
      ),
    );
    require(!used.has(match.row));
    used.add(match.row);
  }
  if (decision === undefined) return 0;
  const stored = rows[0],
    request = stored.request;
  require(stored.tool_call_id === info.toolId && stored.decision === decision);
  date(stored.created_at);
  date(stored.decided_at);
  id(stored.reason);
  require(Date.parse(stored.decided_at) >= Date.parse(stored.created_at));
  require(
    object(request) &&
      request.runId === info.run.run_id &&
      request.sessionId === info.run.session_id,
  );
  same(request.call, {
    id: info.toolId,
    name: info.name,
    arguments: info.arguments,
  });
  require(
    request.tool?.source === "runtime" && request.tool.sourceId === "runtime",
  );
  require(
    request.tool.name === info.name && request.tool.modelName === info.name,
  );
  for (const { connection, row } of deliveries) {
    require(
      connection.agentId === info.run.agent_id &&
        connection.version === info.version,
    );
    const cancelled =
      info.cancelled ||
      (info.entry === "reconnect" && connection.role === "owner");
    require(row.outcome === (cancelled ? "cancelled" : "selected"));
    require(row.optionId === (cancelled ? undefined : decision));
    const params = row.params,
      tool = info.version === 1 ? params.toolCall : params.subject?.toolCall;
    require(
      params.sessionId === info.run.session_id &&
        tool?.toolCallId === info.toolId,
    );
    require(tool.name === info.name && tool.status === "pending");
    require(tool.title === (request.tool.title ?? request.tool.name));
    same(tool.rawInput, info.arguments);
    const offered = list(params.options);
    require(
      offered.length === 4 &&
        new Set(offered.map((item) => item.optionId)).size === 4,
    );
    require(
      offered.every(
        (item) =>
          options.includes(item.optionId) && item.kind === item.optionId,
      ),
    );
    if (!cancelled)
      require(offered.some((item) => item.optionId === row.optionId));
  }
  if (deliveries.length === 2)
    same(deliveries[0].row.params, deliveries[1].row.params);
  return 1;
}

function toolView(update) {
  const result = {};
  for (const key of [
    "sessionUpdate",
    "toolCallId",
    "title",
    "kind",
    "name",
    "rawInput",
    "rawOutput",
    "locations",
    "status",
  ])
    if (update[key] !== undefined) result[key] = update[key];
  if (update.content !== undefined)
    result.content = list(update.content)
      .filter((item) => item.type === "content")
      .map((item) => item.content);
  return result;
}

function projections(event, version) {
  const p = event.payload;
  if (!event.visible) return [];
  if (["user_message", "agent_message"].includes(p.kind)) {
    if (version === 1 || p.responseId !== undefined)
      return p.content.map((content) => ({
        sessionUpdate: `${p.kind}_chunk`,
        messageId: p.responseId ?? p.messageId,
        content,
      }));
    return [
      { sessionUpdate: p.kind, messageId: p.messageId, content: p.content },
    ];
  }
  if (p.kind === "usage")
    return [
      {
        sessionUpdate: "usage_update",
        used: p.used,
        size: p.size,
        ...(p.cost === undefined ? {} : { cost: p.cost }),
      },
    ];
  if (p.kind !== "tool_call") return [];
  return [
    toolView({
      sessionUpdate:
        version === 1 && p.initial ? "tool_call" : "tool_call_update",
      toolCallId: p.toolCallId,
      title: p.title,
      kind: p.toolKind,
      name: p.modelName,
      rawInput: p.arguments,
      rawOutput: p.rawOutput,
      locations: p.file === undefined ? p.locations : [{ path: p.file.path }],
      status: version === 1 && p.status === "cancelled" ? "failed" : p.status,
      ...(p.content === undefined
        ? {}
        : {
            content: p.content.map((content) => ({ type: "content", content })),
          }),
    }),
  ];
}

function checkWire(connections, infos) {
  for (const connection of connections) {
    const allowed = infos.filter(
      (info) =>
        info.run.agent_id === connection.agentId &&
        (connection.role === "owner" ||
          (connection.role === "replay" && info.entry === "reconnect")),
    );
    const expected = [];
    for (const info of allowed) {
      let events = info.events;
      if (connection.role === "owner" && info.entry === "reconnect") {
        const stop = events.findIndex((event) => event.kind === "tool_call");
        require(stop >= 0);
        events = events.slice(0, stop);
      }
      for (const event of events)
        for (const value of projections(event, connection.version))
          expected.push({
            sessionId: info.run.session_id,
            value,
            used: false,
            required:
              event.kind !== "usage" &&
              !(
                event.kind === "user_message" &&
                connection.version === 1 &&
                connection.role === "owner"
              ) &&
              !(
                event.kind === "tool_call" &&
                event.payload.initial === false &&
                event.payload.status === "in_progress"
              ),
          });
    }
    const states = [];
    for (const frame of connection.raw_frames.filter(
      (row) => row.method === "session/update",
    )) {
      const params = frame.params,
        update = params?.update;
      require(
        object(update) &&
          allowed.some((info) => info.run.session_id === params.sessionId),
      );
      if (update.sessionUpdate === "state_update") {
        require(
          connection.version === 2 &&
            ["running", "idle"].includes(update.state),
        );
        states.push(params);
        continue;
      }
      if (
        [
          "config_option_update",
          "current_mode_update",
          "available_commands_update",
          "session_info_update",
        ].includes(update.sessionUpdate)
      )
        continue;
      const value = ["tool_call", "tool_call_update"].includes(
        update.sessionUpdate,
      )
        ? toolView(update)
        : update;
      const matched = expected.find(
        (item) =>
          !item.used &&
          item.sessionId === params.sessionId &&
          isDeepStrictEqual(item.value, value),
      );
      require(matched);
      matched.used = true;
    }
    require(expected.every((item) => !item.required || item.used));
    if (connection.version === 2) {
      for (const info of allowed) {
        if (connection.role === "owner" && info.entry === "reconnect") continue;
        require(
          states.some(
            (row) =>
              row.sessionId === info.run.session_id &&
              row.update.state === "idle" &&
              row.update.stopReason ===
                (info.cancelled ? "cancelled" : "end_turn"),
          ),
        );
        for (const state of states.filter(
          (row) =>
            row.sessionId === info.run.session_id &&
            row.update.state === "idle",
        ))
          require(
            state.update.stopReason === undefined ||
              state.update.stopReason ===
                (info.cancelled ? "cancelled" : "end_turn"),
          );
      }
    }
  }
}

function inspect(input) {
  require(object(input) && list(input.agent_ids).length === 2);
  input.agent_ids.forEach(id);
  require(new Set(input.agent_ids).size === 2);
  id(input.principal_id);
  require(object(input.model_names));
  id(input.model_names.default);
  id(input.model_names.alternate);
  require(input.model_names.default !== input.model_names.alternate);
  verifyModelRequests(
    input.model_requests,
    input.model_names.default,
    input.model_names.alternate,
  );
  const connections = checkConnections(input),
    originals = checkRequests(input, connections);
  require(list(input.agents).length === 2);
  const eventIds = new Set(),
    runIds = new Set(),
    phases = new Set(),
    sessionSequences = new Map(),
    infos = [];
  for (const agentId of input.agent_ids) {
    const agent = one(
      input.agents.filter((value) => value.agent_id === agentId),
    );
    const ready = agent.ready;
    require(object(ready) && ready.agent_id === agentId);
    id(ready.owner_user_id);
    same(ready.owner_user_id, input.principal_id);
    id(ready.agent_spec_revision);
    id(ready.executable_execution_revision);
    require(object(ready.runtime));
    id(ready.runtime.runtime_revision);
    const listed = page(agent.page),
      all = list(agent.all);
    require(listed.length === 13 && all.length === 13);
    const listedIds = new Set();
    for (const summary of listed) {
      id(summary.run_id);
      require(!listedIds.has(summary.run_id));
      listedIds.add(summary.run_id);
    }
    for (const record of all) {
      const run = record.run;
      require(object(run));
      id(run.run_id);
      date(run.created_at);
      date(run.updated_at);
      require(run.agent_id === agentId && !runIds.has(run.run_id));
      runIds.add(run.run_id);
      const summary = one(
        listed.filter((value) => value.run_id === run.run_id),
      );
      require(fieldsEqual(summary, run, summaryFields));
      const phase = run.input?.[0]?.text,
        original = originals.get(phase);
      require(original && !phases.has(phase));
      phases.add(phase);
      const key = JSON.stringify([agentId, run.session_id]);
      if (!sessionSequences.has(key)) sessionSequences.set(key, new Set());
      infos.push(
        checkRun(
          record,
          original,
          eventIds,
          sessionSequences.get(key),
          input,
          ready,
        ),
      );
    }
  }
  require(phases.size === 26 && runIds.size === 26);
  let waits = 0;
  for (const info of infos) waits += checkPermissions(info, input);
  const deliveries = connections.flatMap((connection) =>
    connection.permissions.map((row) => ({ connection, row })),
  );
  require(deliveries.length === 18);
  const used = new Set();
  for (const indexed of input.inventory.permissions) {
    const match = one(
      deliveries.filter(
        ({ connection, row }) =>
          connection.version === indexed.version &&
          connection.agentId === indexed.agentId &&
          fieldsEqual(row, indexed, deliveryFields),
      ),
    );
    require(!used.has(match.row));
    used.add(match.row);
  }
  for (const version of [1, 2]) {
    const owner = one(
      connections.filter((c) => c.version === version && c.role === "owner"),
    );
    const cancel = one(
      infos.filter((info) => info.phase === `v${version}-cancel`),
    );
    const receipt = one(owner.notifications);
    const expected = {
      version,
      agentId: owner.agentId,
      sessionId: cancel.run.session_id,
      method: "session/cancel",
      index: 0,
      status: "write_completed",
      origin: "notify",
      wireObserved: true,
      writeOutcome: "completed",
    };
    require(fieldsEqual(receipt, expected, Object.keys(expected)));
    const indexed = one(
      input.inventory.notifications.filter((row) => row.phase === cancel.phase),
    );
    require(fieldsEqual(indexed.receipt, receipt, Object.keys(expected)));
  }
  checkWire(connections, infos);
  const completed = infos.filter((info) => !info.cancelled).length;
  const cancelled = infos.length - completed,
    executions = infos.filter((info) => info.executes).length;
  require(
    completed === 24 && cancelled === 2 && executions === 16 && waits === 16,
  );
  return {
    status: "passed",
    agents: 2,
    runs: infos.length,
    completed,
    cancelled,
    tool_executions: executions,
    permission_waits: waits,
    permission_deliveries: deliveries.length,
    model_requests: input.model_requests.length,
  };
}

export function inspectPermissionRunBusiness(input) {
  try {
    return inspect(input);
  } catch {
    throw new Error(invalid);
  }
}
