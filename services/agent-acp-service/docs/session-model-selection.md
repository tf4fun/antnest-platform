# Session Model Selection

The Controller owns organization models and provider credentials. ACP owns Session
overrides and execution. The UI renders standard ACP configuration options; it
does not maintain a model catalog or provider-specific request parameters.

## Contract

- `model` selects an enabled organization model profile, including its provider
  connection. Choices are grouped by provider. A separate independent provider
  override would allow invalid provider/model combinations and is not stored.
- `agent_default` removes the Session model override.
- `thinking_effort` uses ACP category `thought_level`. `default` leaves the
  provider's default untouched. Known DeepSeek Flash/V4 models offer Off, Low,
  High and Max. Unknown model IDs do not advertise a reasoning control.
- Changing models clears an effort override unsupported by the new model.
  Disabling a selected model does not silently select another model.
- Changes are persisted in the existing Session configuration JSON and published
  through `config_option_update`. Load/resume/fork retain overrides. Each Run
  snapshots its effective model and effort; later changes apply to later Runs.
- Thinking effort is independent of the tool authorization `mode`.
- No credential or base URL is included in the configuration options.

The model compatibility policy determines supported request parameters, not model
pricing or context limits. Those catalog values remain Controller-owned, with
builtin presets maintained by Console. Additional provider protocols should add
their own capability and request mapping, never client-side model-name guesses.

## Reference And Verification

Goose `crates/goose/src/acp/response_builder.rs` publishes provider/model/effort
configuration and derives effort choices from actual provider capabilities.
Antnest uses one model-profile selection because each profile already identifies
a credentialed provider connection.

[DeepSeek thinking API](https://api-docs.deepseek.com/guides/thinking_mode/)
specifies `thinking.type` plus `reasoning_effort`; enabled thinking ignores
temperature. The request adapter maps explicit selections and omits parameters
for inherited defaults. It retains reasoning history for tool continuations.

Verification covers domain selection and rejection, effective Run snapshots,
provider request JSON, official v1/v2 response schemas, persistence/reconnect/fork,
and Agent UI configuration before its first prompt. No new database table,
private UI configuration endpoint, or Controller RPC is required.
