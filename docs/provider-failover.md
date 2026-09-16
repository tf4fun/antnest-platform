# Provider Availability And Ordered Fallback

## Product Contract

Provider availability is an operational switch, not resource deletion. Disabling
a Provider preserves Template/Agent references and model preferences. Deletion
must remain unavailable while a resource is referenced; this change does not
introduce a cascading delete API.

A Template retains `model_profile_id` as its default and adds ordered
`fallback_model_profile_ids`. Each entry identifies both a Provider connection
and its explicitly chosen model. The order is the administrator's insertion
order, not price, provider brand, or database order. Duplicate connections are
rejected. These preferences are materialized into the Agent configuration.

An explicit Session model is preferred while available. Otherwise ACP selects
the first enabled model on an enabled connection from the Template's default
and fallback list. User-facing configuration updates identify the effective
selection and report fallback; users can still select an available organization
model. If none is available, prompting fails without disabling the Agent's
lifecycle or preventing configuration/history access.

Disabling a Provider revokes its clients when the Controller publication reaches
ACP. Requests and Runs using that client fail promptly, including holders that
have not made their next model request. There is no graceful draining and no
automatic replay of a failed Run or Tool. Already performed external effects
cannot be undone. Re-enabling creates usable clients for future executions;
revoked handles do not become valid again.

Automatic selection handles known configuration availability, not arbitrary
upstream failures. A timeout/429/5xx is reported on the current execution; it
does not silently retry the conversation with another paid model. Administrators
can disable a faulty connection and later restore it.

## Ownership And Delivery

1. Controller: validate and persist ordered references, publish them with Agent
   configuration, support the OpenRouter connection type, and allow Provider
   disable with references. Lifecycle readiness is independent of the default
   Provider's availability.
2. ACP: support OpenRouter's OpenAI-compatible endpoint, perform deterministic
   selection, revoke disabled clients, and publish standard ACP configuration
   changes plus a visible fallback notice. No Controller access in a Run loop.
3. Admin Console: maintain built-in OpenRouter model presets alongside DeepSeek;
   configure ordered Provider/model choices in Templates; explain disable impact.
4. Agent UI: render ACP's effective selection and fallback notice. It does not
   own credentials, model metadata, or fallback policy.
5. Integration: verify the producer/consumer contract, two-provider selection,
   disable during execution, restoration, manual override, and no-candidate
   failure. No claim of real OpenRouter verification without an actual credential.

## Correctness Cases

- Preserve candidate order through Template save/load, Agent materialization,
  and execution publication; reject foreign, missing, duplicate candidates.
- Disable a referenced Provider, keep references and model enabled flags, publish
  its unavailability without initiating an Agent rebuild.
- Prefer the default; skip disabled connections/models; respect manual selection;
  report fallback and fail clearly when no candidate is available.
- Revoke an in-flight request and an acquired but idle client; restoring a
  Provider must not revive a revoked Run. Do not retry prior tool effects.
- OpenRouter auth, endpoint path, streamed text, tool calls, usage, and upstream
  errors use the existing model transport contract without DeepSeek-only fields.
- A repeated terminal choice carrying usage and `role: assistant` is accepted
  only without additional content, reasoning, refusal or Tool output. Changed
  output or finish reasons remain protocol errors.
- Cancellation is owned by the model transport: pending I/O is aborted, and
  already received usage/cost is retained exactly once. Client revocation must
  not race away the transport's accounting result.
- Runtime health changes advance the execution publication revision even when
  the default Provider is disabled. Model selection never gates health updates.
- Console ordering and UI notifications survive reload; no client contains a key.

OpenRouter endpoint and wire format follow the
[official API reference](https://openrouter.ai/docs/api/reference/overview).

## Verification (2026-09-15)

| Scope                                                     | Final result                                                                                        |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Controller, including isolated PostgreSQL and race checks | 531 tests and 567 subtests passed; 3 separate Temporal tests skipped without their test environment |
| ACP unit/component tests                                  | 956 passed                                                                                          |
| ACP PostgreSQL/protocol integration                       | 224 passed, including v1/v2 configuration updates and fallback                                      |
| Console web                                               | 111 unit and 272 component tests passed                                                             |
| Agent UI                                                  | 67 unit and 127 component tests passed                                                              |
| Admission                                                 | `make lint`, `make fmt-check`, affected Go service tests passed                                     |

Real browser acceptance uses the deployed Gateway, Console, Controller, ACP and
Agent UI with actual DeepSeek and OpenRouter credentials. It checks the selected
Provider/model against each Run's persisted audit, not just a UI label. Cases:
default DeepSeek, disabling a referenced Provider, automatic OpenRouter fallback,
reload, manual OpenRouter selection, all Providers unavailable, and no prompt
replay. Desktop and 390/320px layouts are inspected. In-flight revocation and
accounting are deterministic service tests, not claimed as real-provider fault
injection.

The recorded browser run passed on 2026-09-15 at 23:12 +08:00. Its local result,
`.cache/provider-failover-acceptance/result.json`, records three real responses,
ordered backups, referenced Provider disable, live configuration updates,
reload/manual selection, no available candidate, no prompt replay and layout
checks. See [current status](current-status.md) for the evidence boundary; this
does not make the separate development-browser strict Trace profile pass.

Run the reusable acceptance script from the repository root:

```sh
node scripts/workspace-closeout/provider-failover-browser.mjs \
  --confirm-development --real-models
```

This opt-in script reads bootstrap settings from `.env` and OpenRouter's key from
`../.secret`, makes three short paid requests, and may add the Provider/model,
publish a Template revision and rebuild one development Agent. Availability
switches are restored in `finally`. No secret is printed. Compact results and
screenshots go to ignored `.cache/provider-failover-acceptance/`; the script itself
is maintained under `scripts/`, not in the cache. No live Provider error causes
automatic replay or silent paid-model retries.
