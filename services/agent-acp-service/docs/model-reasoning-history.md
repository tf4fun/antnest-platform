# Model Reasoning History

This document describes how provider reasoning content is retained across Tool
turns and stored conversation context.

The OpenAI-compatible adapter preserves provider-returned `reasoning_content`
separately from visible assistant text. DeepSeek thinking mode requires it in
subsequent requests carrying tools, including after a rejected tool call and
after loading a previous conversation.

- `ModelMessage.thought` belongs only to assistant messages. It is not a system
  instruction or a user message.
- The tool loop keeps the complete model response reasoning when appending an
  assistant/tool exchange. The adapter serializes it as `reasoning_content`.
- An explicitly empty/null reasoning field is retained as empty text, not
  discarded as absent. Thinking-mode providers may return a Tool call without
  reasoning text but still require `reasoning_content: ""` on the next request.
  Providers that omit the field entirely do not acquire a fabricated field.
- Existing durable `agent_thought` events are joined with their assistant
  response when projecting stored context. Chunk boundaries are not model
  message boundaries. Unfinished reasoning cannot cross a user/environment/tool
  boundary and become another response's reasoning.
- Context budgets include retained reasoning. Compaction removes complete
  messages/tool exchanges; the summary does not invent replacement reasoning.
- ACP thought notifications and visible replies remain separate. Reasoning
  retention does not alter Controller, Runtime, the ACP wire contract or database schema.

Regression coverage lives in the model adapter, turn runner, context builder,
PostgreSQL context projection and durable-streaming integration tests.

Reference: [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/).
