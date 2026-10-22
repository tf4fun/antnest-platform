package application

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestRuntimeBarrierRecoveryAdmissionReplaysOriginalReceiptBeforePreparation(t *testing.T) {
	for _, operationState := range []domain.OperationState{domain.OperationRunning, domain.OperationCompleted, domain.OperationFailed} {
		for _, changedInput := range []string{"new-template-and-expectations", "missing-command-and-expectations"} {
			t.Run(string(operationState)+"/"+changedInput, func(t *testing.T) {
				fixture := newRuntimeBarrierAdmissionApplicationFixture(t)
				fixture.store.receiptPresent = true
				fixture.store.state = fixture.originalState(t, operationState)
				fixture.specs.err = errors.New("current catalog must not be read on replay")
				fixture.store.baseErr = errors.New("current Agent must not be read on replay")
				input := fixture.intent
				input.ExpectedPolicyRevision = -1
				input.ExpectedOwnerUserID = ""
				input.ExpectedOwnerAuthorizationSequence = -1
				input.ExpectedIdentityRevocationSequence = -1
				if changedInput == "new-template-and-expectations" {
					input.Command.TemplateID = "new-template"
					input.Command.TemplateRevision = 99
				} else {
					input.Command = ports.RuntimeBarrierRebuildCommand{}
				}
				before := cloneRuntimeBarrierAdmissionApplicationIntent(input)

				result, err := fixture.service.Admit(context.Background(), input)

				require.NoError(t, err)
				require.True(t, result.Replayed)
				require.Equal(t, fixture.store.state, result.State)
				require.Equal(t, fixture.receipt, result.Receipt)
				require.Equal(t, before, input)
				require.Equal(t, []string{"recovery.replay", "lifecycle.replay"}, fixture.store.calls)
				require.Equal(t, [][3]string{{fixture.intent.Fact.OrganizationID, fixture.intent.Fact.AgentID, fixture.intent.Fact.Barrier.BarrierID}}, fixture.store.receiptKeys)
				require.Equal(t, [][2]string{{fixture.receipt.Command.RequestID, fixture.receipt.RequestFingerprint}}, fixture.store.replayKeys)
				fixture.assertNoPreparation(t)
			})
		}
	}
}

func TestRuntimeBarrierRecoveryAdmissionRejectsInvalidFactsAndNewIntents(t *testing.T) {
	facts := []struct {
		name string
		edit func(*ports.RuntimeBarrierRecoveryIntent)
	}{
		{"missing-organization", func(input *ports.RuntimeBarrierRecoveryIntent) { input.Fact.OrganizationID = "" }},
		{"invalid-Agent-scope", func(input *ports.RuntimeBarrierRecoveryIntent) { input.Fact.AgentID = "agent/foreign" }},
		{"missing-runtime-revision", func(input *ports.RuntimeBarrierRecoveryIntent) { input.Fact.RuntimeRevision = "" }},
		{"missing-barrier", func(input *ports.RuntimeBarrierRecoveryIntent) { input.Fact.Barrier = nil }},
		{"missing-barrier-ID", func(input *ports.RuntimeBarrierRecoveryIntent) { input.Fact.Barrier.BarrierID = "" }},
		{"invalid-barrier-ID", func(input *ports.RuntimeBarrierRecoveryIntent) {
			input.Fact.Barrier.BarrierID = "barrier with whitespace"
		}},
		{"missing-execution-ID", func(input *ports.RuntimeBarrierRecoveryIntent) { input.Fact.Barrier.RuntimeExecutionID = "" }},
		{"different-reason", func(input *ports.RuntimeBarrierRecoveryIntent) { input.Fact.Barrier.Reason = "worker_lost" }},
	}
	for _, scenario := range facts {
		t.Run("fact/"+scenario.name, func(t *testing.T) {
			fixture := newRuntimeBarrierAdmissionApplicationFixture(t)
			fixture.store.receiptPresent = true
			input := cloneRuntimeBarrierAdmissionApplicationIntent(fixture.intent)
			scenario.edit(&input)

			_, err := fixture.service.Admit(context.Background(), input)

			require.ErrorIs(t, err, ports.ErrInvalidRuntimeBarrierRecovery)
			require.Empty(t, fixture.store.calls)
			fixture.assertNoPreparation(t)
		})
	}

	intents := []struct {
		name string
		edit func(*ports.RuntimeBarrierRecoveryIntent)
	}{
		{"wrong-request-ID", func(input *ports.RuntimeBarrierRecoveryIntent) { input.Command.RequestID = "other-request" }},
		{"foreign-organization", func(input *ports.RuntimeBarrierRecoveryIntent) { input.Command.OrganizationID = "other-org" }},
		{"foreign-Agent", func(input *ports.RuntimeBarrierRecoveryIntent) { input.Command.AgentID = "other-agent" }},
		{"different-actor", func(input *ports.RuntimeBarrierRecoveryIntent) { input.Command.ActorPrincipalID = "user-1" }},
		{"invalid-template", func(input *ports.RuntimeBarrierRecoveryIntent) { input.Command.TemplateID = "template/invalid" }},
		{"zero-template-revision", func(input *ports.RuntimeBarrierRecoveryIntent) { input.Command.TemplateRevision = 0 }},
		{"negative-policy-revision", func(input *ports.RuntimeBarrierRecoveryIntent) { input.ExpectedPolicyRevision = -1 }},
		{"unsafe-policy-revision", func(input *ports.RuntimeBarrierRecoveryIntent) { input.ExpectedPolicyRevision = 9007199254740992 }},
		{"missing-owner", func(input *ports.RuntimeBarrierRecoveryIntent) { input.ExpectedOwnerUserID = "" }},
		{"negative-owner-watermark", func(input *ports.RuntimeBarrierRecoveryIntent) { input.ExpectedOwnerAuthorizationSequence = -1 }},
		{"negative-revocation-watermark", func(input *ports.RuntimeBarrierRecoveryIntent) { input.ExpectedIdentityRevocationSequence = -1 }},
	}
	for _, scenario := range intents {
		t.Run("new-intent/"+scenario.name, func(t *testing.T) {
			fixture := newRuntimeBarrierAdmissionApplicationFixture(t)
			input := cloneRuntimeBarrierAdmissionApplicationIntent(fixture.intent)
			scenario.edit(&input)

			_, err := fixture.service.Admit(context.Background(), input)

			require.ErrorIs(t, err, ports.ErrInvalidRuntimeBarrierRecovery)
			require.Equal(t, []string{"recovery.replay"}, fixture.store.calls)
			fixture.assertNoPreparation(t)
		})
	}
}

func TestRuntimeBarrierRecoveryAdmissionRejectsInvalidReceiptsAndOperations(t *testing.T) {
	scenarios := []struct {
		name string
		edit func(*runtimeBarrierAdmissionApplicationFixture)
	}{
		{"receipt-foreign-organization", func(fixture *runtimeBarrierAdmissionApplicationFixture) {
			fixture.store.receipt.Fact.OrganizationID = "other-org"
		}},
		{"receipt-foreign-Agent", func(fixture *runtimeBarrierAdmissionApplicationFixture) {
			fixture.store.receipt.Fact.AgentID = "other-agent"
		}},
		{"receipt-other-barrier", func(fixture *runtimeBarrierAdmissionApplicationFixture) {
			fixture.store.receipt.Fact.Barrier.BarrierID = "other-barrier"
		}},
		{"receipt-command-foreign-organization", func(fixture *runtimeBarrierAdmissionApplicationFixture) {
			fixture.store.receipt.Command.OrganizationID = "other-org"
		}},
		{"receipt-command-foreign-Agent", func(fixture *runtimeBarrierAdmissionApplicationFixture) {
			fixture.store.receipt.Command.AgentID = "other-agent"
		}},
		{"receipt-other-request", func(fixture *runtimeBarrierAdmissionApplicationFixture) {
			fixture.store.receipt.Command.RequestID = "other-request"
		}},
		{"receipt-fingerprint", func(fixture *runtimeBarrierAdmissionApplicationFixture) {
			fixture.store.receipt.RequestFingerprint = strings.Repeat("b", 64)
		}},
		{"receipt-policy-foreign-organization", func(fixture *runtimeBarrierAdmissionApplicationFixture) {
			fixture.store.receipt.Policy.OrganizationID = "other-org"
		}},
		{"operation-missing", func(fixture *runtimeBarrierAdmissionApplicationFixture) { fixture.store.replayFound = false }},
		{"operation-foreign-organization", func(fixture *runtimeBarrierAdmissionApplicationFixture) {
			fixture.store.state.Agent.OrganizationID = "other-org"
		}},
		{"operation-foreign-Agent", func(fixture *runtimeBarrierAdmissionApplicationFixture) {
			fixture.store.state.Agent.AgentID = "other-agent"
		}},
		{"operation-other-target-Agent", func(fixture *runtimeBarrierAdmissionApplicationFixture) {
			fixture.store.state.Operation.AgentID = "other-agent"
		}},
		{"operation-other-request", func(fixture *runtimeBarrierAdmissionApplicationFixture) {
			fixture.store.state.Operation.RequestID = "other-request"
		}},
		{"operation-fingerprint", func(fixture *runtimeBarrierAdmissionApplicationFixture) {
			fixture.store.state.Operation.RequestFingerprint = strings.Repeat("c", 64)
		}},
		{"operation-other-kind", func(fixture *runtimeBarrierAdmissionApplicationFixture) {
			fixture.store.state.Operation.Kind = domain.OperationCreate
		}},
		{"operation-other-source-runtime", func(fixture *runtimeBarrierAdmissionApplicationFixture) {
			fixture.store.state.Operation.SourceRuntimeRevision = "rtv_other_original_runtime"
		}},
	}
	for _, scenario := range scenarios {
		t.Run(scenario.name, func(t *testing.T) {
			fixture := newRuntimeBarrierAdmissionApplicationFixture(t)
			fixture.store.receiptPresent = true
			scenario.edit(fixture)

			_, err := fixture.service.Admit(context.Background(), fixture.intent)

			require.ErrorIs(t, err, ErrQueryContract)
			require.Len(t, fixture.store.receiptKeys, 1)
			fixture.assertNoPreparation(t)
		})
	}

	for _, source := range []string{"receipt", "operation"} {
		t.Run(source+"-read-error", func(t *testing.T) {
			fixture := newRuntimeBarrierAdmissionApplicationFixture(t)
			original := errors.New("original " + source + " read failure")
			if source == "receipt" {
				fixture.store.reads = []runtimeBarrierAdmissionApplicationRead{{err: original}}
			} else {
				fixture.store.receiptPresent = true
				fixture.store.replayErr = original
			}

			_, err := fixture.service.Admit(context.Background(), fixture.intent)

			require.ErrorIs(t, err, original)
			require.Len(t, fixture.store.receiptKeys, 1)
			fixture.assertNoPreparation(t)
		})
	}
}

func TestRuntimeBarrierRecoveryAdmissionPreservesPublicRebuildPreparationAndFingerprint(t *testing.T) {
	fixture := newRuntimeBarrierAdmissionApplicationFixture(t)
	before := cloneRuntimeBarrierAdmissionApplicationIntent(fixture.intent)

	result, err := fixture.service.Admit(context.Background(), fixture.intent)

	require.NoError(t, err)
	require.False(t, result.Replayed)
	require.Equal(t, before, fixture.intent)
	require.Equal(t, fixture.receipt, result.Receipt)
	require.Equal(t, fixture.store.state, result.State)
	require.Equal(t, fixture.receipt.AcceptedAt, result.State.Operation.CreatedAt)
	require.NotEqual(t, fixture.now, result.Receipt.AcceptedAt, "acceptance comes from the durable receipt, not the preparation clock")
	require.Equal(t, []string{"recovery.replay", "lifecycle.base", "lifecycle.begin", "recovery.replay"}, fixture.store.calls)
	require.Empty(t, fixture.store.replayKeys, "a public operation replay is not a recovery receipt")
	require.Equal(t, fixture.intent, *fixture.store.begin.Recovery)
	require.Equal(t, fixture.intent.Fact.Barrier.RuntimeExecutionID, fixture.store.begin.Recovery.Fact.Barrier.RuntimeExecutionID)
	require.NotEqual(t, fixture.store.base.Agent.RuntimeExecutionID, fixture.store.begin.Recovery.Fact.Barrier.RuntimeExecutionID)
	require.Equal(t, fixture.receipt.RequestFingerprint, fixture.store.begin.Operation.RequestFingerprint)
	require.Equal(t, domain.DeriveResourceID("agentspec", "agentspec-rebuild", fixture.intent.Command.RequestID), fixture.store.begin.TargetSpec.ID)
	require.Equal(t, fixture.now, fixture.store.begin.Now)
	require.NotNil(t, fixture.store.begin.Operation.DrainDeadlineAt)
	require.Equal(t, fixture.now.Add(defaultDrainTimeout), *fixture.store.begin.Operation.DrainDeadlineAt)
	require.Equal(t, 1, fixture.skills.reserved)
	require.Equal(t, 1, fixture.client.calls)

	ordinary := newRuntimeBarrierAdmissionApplicationFixture(t)
	ordinary.store.replayFound = false
	_, err = ordinary.lifecycle.RebuildAgent(context.Background(), runtimeBarrierAdmissionApplicationCommandInput(ordinary.intent.Command))
	require.NoError(t, err)
	require.Nil(t, ordinary.store.begin.Recovery)
	require.Len(t, ordinary.store.replayKeys, 1, "ordinary Rebuild keeps its existing replay fast path")
	prepared := fixture.store.begin
	prepared.Recovery = nil
	prepared.RequestedEvent.Data = runtimeBarrierAdmissionApplicationEventData(prepared.RequestedEvent.Data)
	if reason, found := prepared.RequestedEvent.Data["rebuild_reason"]; found {
		require.Equal(t, "barrier", reason)
		delete(prepared.RequestedEvent.Data, "rebuild_reason")
	}
	require.Equal(t, ordinary.store.begin, prepared, "recovery metadata must not change public Rebuild preparation or fingerprint")
	require.Equal(t, 6, reflect.TypeOf(RebuildAgentInput{}).NumField(), "recovery facts do not extend the public Rebuild wire")
}

func TestRuntimeBarrierRecoveryAdmissionReusesFrozenSkillIntent(t *testing.T) {
	for _, preparationState := range []string{"ready", "preparing"} {
		t.Run(preparationState, func(t *testing.T) {
			fixture := newRuntimeBarrierAdmissionApplicationFixture(t)
			frozen := fixture.store.base.ConfiguredSpec.Snapshot
			frozenDigest := fixture.store.base.ConfiguredSpec.CanonicalDigest
			fixture.skills.intent = ports.SkillPreparationIntent{
				RequestID: fixture.intent.Command.RequestID, RequestFingerprint: fixture.receipt.RequestFingerprint,
				Kind: domain.OperationRebuild, AgentID: fixture.intent.Fact.AgentID, OrganizationID: fixture.intent.Fact.OrganizationID,
				TargetSpec: frozen, TargetSpecDigest: frozenDigest, State: "ready",
				PreparedReferenceID:         "psr_11111111111111111111111111111111",
				ExpectedAggregateSequence:   fixture.store.base.Agent.AggregateSequence,
				ExpectedSpecRevisionID:      fixture.store.base.ConfiguredSpec.ID,
				ExpectedExecutionRevisionID: fixture.store.base.SourceExecution.ID,
				ExpectedRuntimeRevision:     fixture.store.base.Agent.RuntimeRevision,
				CreatedAt:                   fixture.now.Add(-time.Minute), UpdatedAt: fixture.now.Add(-time.Minute),
			}
			fixture.specs.err = errors.New("catalog changed after the durable Skill intent")
			fixture.client.state = preparationState

			result, err := fixture.service.Admit(context.Background(), fixture.intent)

			require.Empty(t, fixture.specs.calls)
			require.Equal(t, 1, fixture.skills.reserved)
			require.Equal(t, 1, fixture.client.calls, "reuse the existing idempotent preparation protocol")
			require.Equal(t, []string{skillPreparationRequestID(fixture.intent.Command.RequestID, 0)}, fixture.client.requestIDs)
			require.Equal(t, frozen, fixture.skills.intent.TargetSpec)
			require.Equal(t, frozenDigest, fixture.skills.intent.TargetSpecDigest)
			if preparationState == "preparing" {
				require.ErrorIs(t, err, ErrDependencyUnavailable)
				require.Equal(t, 0, fixture.store.beginCalls)
				return
			}
			require.NoError(t, err)
			require.False(t, result.Replayed)
			require.Equal(t, frozen, fixture.store.begin.TargetSpec.Snapshot)
			require.Equal(t, frozenDigest, fixture.store.begin.TargetSpec.CanonicalDigest)
		})
	}
}

func TestRuntimeBarrierRecoveryAdmissionPreservesErrorsAndRecoversCommittedReceipts(t *testing.T) {
	for _, failure := range []error{ports.ErrConcurrentChange, ports.ErrRequestConflict, errors.New("original Begin failure")} {
		t.Run("Begin/"+failure.Error(), func(t *testing.T) {
			fixture := newRuntimeBarrierAdmissionApplicationFixture(t)
			fixture.store.beginErr = failure

			_, err := fixture.service.Admit(context.Background(), fixture.intent)

			require.ErrorIs(t, err, failure)
			require.Equal(t, 1, fixture.store.beginCalls)
			require.Empty(t, fixture.store.replayKeys, "ordinary operation hits cannot bypass recovery admission")
			require.False(t, fixture.store.durable)
		})
	}

	t.Run("preparation-error-without-receipt", func(t *testing.T) {
		fixture := newRuntimeBarrierAdmissionApplicationFixture(t)
		original := errors.New("original catalog failure")
		fixture.specs.err = original

		_, err := fixture.service.Admit(context.Background(), fixture.intent)

		require.ErrorIs(t, err, original)
		require.Equal(t, 0, fixture.store.beginCalls)
		require.Equal(t, 0, fixture.skills.reserved)
		require.Empty(t, fixture.store.replayKeys)
	})

	for _, postCommit := range []string{"read-error", "missing-receipt", "wrong-scope"} {
		t.Run("durable-Begin/"+postCommit, func(t *testing.T) {
			fixture := newRuntimeBarrierAdmissionApplicationFixture(t)
			original := errors.New("receipt unavailable after durable Begin")
			reply := runtimeBarrierAdmissionApplicationRead{}
			switch postCommit {
			case "read-error":
				reply.err = original
			case "wrong-scope":
				reply.receipt = cloneRuntimeBarrierAdmissionApplicationReceipt(fixture.receipt)
				reply.receipt.Fact.AgentID = "other-agent"
				reply.found = true
			}
			fixture.store.reads = []runtimeBarrierAdmissionApplicationRead{{}, reply}

			_, err := fixture.service.Admit(context.Background(), fixture.intent)

			if postCommit == "read-error" {
				require.ErrorIs(t, err, original)
			} else {
				require.ErrorIs(t, err, ErrQueryContract)
			}
			require.True(t, fixture.store.durable, "receipt read failures do not undo a durable pending start")
			require.Equal(t, 1, fixture.store.beginCalls)
			require.Len(t, fixture.store.receiptKeys, 2)
		})
	}

	t.Run("concurrent-commit-wins-over-preparation-error", func(t *testing.T) {
		fixture := newRuntimeBarrierAdmissionApplicationFixture(t)
		fixture.specs.err = errors.New("catalog became unavailable during another admission")
		fixture.store.reads = []runtimeBarrierAdmissionApplicationRead{{}, {receipt: fixture.receipt, found: true}}

		result, err := fixture.service.Admit(context.Background(), fixture.intent)

		require.NoError(t, err)
		require.True(t, result.Replayed)
		require.Equal(t, fixture.receipt, result.Receipt)
		require.Equal(t, fixture.store.state, result.State)
		require.Equal(t, 0, fixture.store.beginCalls)
		require.Len(t, fixture.store.replayKeys, 1)
	})

	t.Run("unknown-Begin-commit-replays-original-receipt", func(t *testing.T) {
		fixture := newRuntimeBarrierAdmissionApplicationFixture(t)
		fixture.store.beginErr = errors.New("connection lost after commit")
		fixture.store.commitBeforeError = true

		result, err := fixture.service.Admit(context.Background(), fixture.intent)

		require.NoError(t, err)
		require.True(t, result.Replayed)
		require.Equal(t, fixture.receipt, result.Receipt)
		require.Equal(t, fixture.store.state, result.State)
		require.Equal(t, 1, fixture.store.beginCalls)
		require.Len(t, fixture.store.replayKeys, 1)
		require.True(t, fixture.store.durable)
	})
}

type runtimeBarrierAdmissionApplicationRead struct {
	receipt ports.RuntimeBarrierRecoveryReceipt
	found   bool
	err     error
}

type runtimeBarrierAdmissionApplicationStore struct {
	rebuildLifecycleStoreStub
	calls             []string
	receiptKeys       [][3]string
	replayKeys        [][2]string
	reads             []runtimeBarrierAdmissionApplicationRead
	receipt           ports.RuntimeBarrierRecoveryReceipt
	receiptPresent    bool
	replayFound       bool
	replayErr         error
	beginErr          error
	beginCalls        int
	commitBeforeError bool
	durable           bool
	startCalls        int
	advanceCalls      int
}

func (store *runtimeBarrierAdmissionApplicationStore) ReplayRuntimeBarrierRecovery(_ context.Context, organizationID, agentID, barrierID string) (ports.RuntimeBarrierRecoveryReceipt, bool, error) {
	store.calls = append(store.calls, "recovery.replay")
	store.receiptKeys = append(store.receiptKeys, [3]string{organizationID, agentID, barrierID})
	if index := len(store.receiptKeys) - 1; index < len(store.reads) {
		reply := store.reads[index]
		return reply.receipt, reply.found, reply.err
	}
	if store.receiptPresent || store.durable {
		return store.receipt, true, nil
	}
	return ports.RuntimeBarrierRecoveryReceipt{}, false, nil
}

func (store *runtimeBarrierAdmissionApplicationStore) ListPendingRuntimeBarrierRecoveryStarts(context.Context, string, int) ([]ports.RuntimeBarrierRecoveryReceipt, error) {
	store.startCalls++
	return nil, errors.New("admission must not list workflow starts")
}

func (store *runtimeBarrierAdmissionApplicationStore) ConfirmRuntimeBarrierRecoveryStarted(context.Context, string, string) error {
	store.startCalls++
	return errors.New("admission must not confirm workflow starts")
}

func (store *runtimeBarrierAdmissionApplicationStore) ReplayAgentRebuild(_ context.Context, requestID, fingerprint string) (ports.AgentRebuildState, bool, error) {
	store.calls = append(store.calls, "lifecycle.replay")
	store.replayKeys = append(store.replayKeys, [2]string{requestID, fingerprint})
	return store.state, store.replayFound, store.replayErr
}

func (store *runtimeBarrierAdmissionApplicationStore) GetAgentLifecycleBase(context.Context, string) (ports.AgentLifecycleBase, error) {
	store.calls = append(store.calls, "lifecycle.base")
	return store.base, store.baseErr
}

func (store *runtimeBarrierAdmissionApplicationStore) BeginAgentRebuild(_ context.Context, input ports.BeginAgentRebuild) (ports.AgentRebuildState, bool, error) {
	store.calls = append(store.calls, "lifecycle.begin")
	store.beginCalls++
	store.begin = input
	if store.beginErr != nil && !store.commitBeforeError {
		return ports.AgentRebuildState{}, false, store.beginErr
	}
	agent := store.base.Agent
	agent.ActiveOperationRequestID = input.Operation.RequestID
	agent.AggregateSequence = input.RequestedEvent.AggregateSequence
	agent.UpdatedAt = input.Now
	store.state = ports.AgentRebuildState{
		Agent: agent, SourceSpec: store.base.ConfiguredSpec, SourceExecution: store.base.SourceExecution,
		TargetSpec: input.TargetSpec, Operation: input.Operation,
	}
	if input.Recovery != nil {
		store.durable = true
		store.state.Agent.UpdatedAt = store.receipt.AcceptedAt
		store.state.TargetSpec.CreatedAt = store.receipt.AcceptedAt
		store.state.Operation.CreatedAt = store.receipt.AcceptedAt
		store.state.Operation.UpdatedAt = store.receipt.AcceptedAt
		if input.Operation.DrainDeadlineAt != nil {
			deadline := store.receipt.AcceptedAt.Add(input.Operation.DrainDeadlineAt.Sub(input.Now))
			store.state.Operation.DrainDeadlineAt = &deadline
		}
	}
	return store.state, false, store.beginErr
}

func (store *runtimeBarrierAdmissionApplicationStore) AdvanceAgentRebuild(context.Context, ports.AdvanceAgentRebuild) (ports.LifecycleAdvanceResult, error) {
	store.advanceCalls++
	return ports.LifecycleAdvanceResult{}, errors.New("admission must not advance a workflow")
}

func (store *runtimeBarrierAdmissionApplicationStore) PublishAgentRebuild(context.Context, ports.PublishAgentRebuild) (ports.AgentRebuildState, error) {
	store.advanceCalls++
	return ports.AgentRebuildState{}, errors.New("admission must not publish a workflow")
}

func (store *runtimeBarrierAdmissionApplicationStore) FailAgentRebuild(context.Context, ports.FailAgentRebuild) (ports.AgentRebuildState, error) {
	store.advanceCalls++
	return ports.AgentRebuildState{}, errors.New("admission must not settle a workflow")
}

type runtimeBarrierAdmissionApplicationSpecs struct {
	lifecycleSpecSourceStub
	calls []string
	err   error
}

func (source *runtimeBarrierAdmissionApplicationSpecs) GetTemplateRevision(ctx context.Context, templateID string, revision int64) (domain.TemplateRevision, error) {
	source.calls = append(source.calls, "template")
	if source.err != nil {
		return domain.TemplateRevision{}, source.err
	}
	return source.lifecycleSpecSourceStub.GetTemplateRevision(ctx, templateID, revision)
}

func (source *runtimeBarrierAdmissionApplicationSpecs) GetCurrentModelProfileRevision(ctx context.Context, modelID string) (domain.ModelProfileRevision, error) {
	source.calls = append(source.calls, "model")
	if source.err != nil {
		return domain.ModelProfileRevision{}, source.err
	}
	return source.lifecycleSpecSourceStub.GetCurrentModelProfileRevision(ctx, modelID)
}

type runtimeBarrierAdmissionApplicationSkills struct {
	skillIntentStub
	reads int
}

func (store *runtimeBarrierAdmissionApplicationSkills) GetSkillPreparationIntent(ctx context.Context, requestID string) (ports.SkillPreparationIntent, error) {
	store.reads++
	return store.skillIntentStub.GetSkillPreparationIntent(ctx, requestID)
}

type runtimeBarrierAdmissionApplicationEffects struct {
	calls []string
}

func (effects *runtimeBarrierAdmissionApplicationEffects) unexpected(name string) error {
	effects.calls = append(effects.calls, name)
	return errors.New("unexpected admission effect: " + name)
}

func (effects *runtimeBarrierAdmissionApplicationEffects) GetAgentNetwork(context.Context, string) (ports.NetworkAttachment, error) {
	return ports.NetworkAttachment{}, effects.unexpected("egress.get")
}

func (effects *runtimeBarrierAdmissionApplicationEffects) EnsureAgentNetwork(context.Context, string) (ports.NetworkAttachment, error) {
	return ports.NetworkAttachment{}, effects.unexpected("egress.ensure")
}

func (effects *runtimeBarrierAdmissionApplicationEffects) SetAgentNetworkAttachment(context.Context, string, string, uint64, string, string) (ports.NetworkAttachment, error) {
	return ports.NetworkAttachment{}, effects.unexpected("egress.attachment")
}

func (effects *runtimeBarrierAdmissionApplicationEffects) ReleaseAgentNetwork(context.Context, string, uint64) (ports.NetworkAttachment, error) {
	return ports.NetworkAttachment{}, effects.unexpected("egress.release")
}

func (effects *runtimeBarrierAdmissionApplicationEffects) InitializeRuntime(context.Context, string, string, ports.RuntimeConfiguration) (ports.RuntimeOperation, error) {
	return ports.RuntimeOperation{}, effects.unexpected("runtime.initialize")
}

func (effects *runtimeBarrierAdmissionApplicationEffects) UpdateRuntime(context.Context, string, string, string, ports.RuntimeConfiguration) (ports.RuntimeOperation, error) {
	return ports.RuntimeOperation{}, effects.unexpected("runtime.update")
}

func (effects *runtimeBarrierAdmissionApplicationEffects) DisableRuntime(context.Context, string, string, string) (ports.RuntimeOperation, error) {
	return ports.RuntimeOperation{}, effects.unexpected("runtime.disable")
}

func (effects *runtimeBarrierAdmissionApplicationEffects) EnableRuntime(context.Context, string, string, string, ports.RuntimeConfiguration) (ports.RuntimeOperation, error) {
	return ports.RuntimeOperation{}, effects.unexpected("runtime.enable")
}

func (effects *runtimeBarrierAdmissionApplicationEffects) DeleteRuntime(context.Context, string, string, string) (ports.RuntimeOperation, error) {
	return ports.RuntimeOperation{}, effects.unexpected("runtime.delete")
}

func (effects *runtimeBarrierAdmissionApplicationEffects) InspectRuntime(context.Context, string) (ports.RuntimeInspection, error) {
	return ports.RuntimeInspection{}, effects.unexpected("runtime.inspect")
}

func (effects *runtimeBarrierAdmissionApplicationEffects) CloseAndSettle(context.Context, ports.LifecycleSettlementRequest) (ports.AgentSettlementResult, error) {
	return ports.AgentSettlementResult{}, effects.unexpected("execution.settle")
}

type runtimeBarrierAdmissionApplicationFixture struct {
	store     *runtimeBarrierAdmissionApplicationStore
	specs     *runtimeBarrierAdmissionApplicationSpecs
	skills    *runtimeBarrierAdmissionApplicationSkills
	client    *skillPreparationClientStub
	effects   *runtimeBarrierAdmissionApplicationEffects
	lifecycle *LifecycleService
	service   *RuntimeBarrierRecoveryAdmissionService
	intent    ports.RuntimeBarrierRecoveryIntent
	receipt   ports.RuntimeBarrierRecoveryReceipt
	now       time.Time
}

func newRuntimeBarrierAdmissionApplicationFixture(t *testing.T) *runtimeBarrierAdmissionApplicationFixture {
	t.Helper()
	template, model := mustLifecycleTemplate(t), mustLifecycleModel(t)
	base := rebuildLifecycleBase(t, template, model)
	base.Agent.AggregateSequence = 9
	base.Agent.OwnerAuthorizationSequence = 11
	base.Agent.IdentityRevocationSequence = 10
	fact := ports.RuntimeBarrierResult{
		OrganizationID: base.Agent.OrganizationID, AgentID: base.Agent.AgentID, RuntimeRevision: base.Agent.RuntimeRevision,
		Barrier: &ports.RuntimeBarrier{BarrierID: "barrier-e\u0301-🧪", Reason: ports.ExecutionRuntimeBarrierRequired, RuntimeExecutionID: "original-execution-🧪-\u0085"},
	}
	requestID, err := ports.RuntimeBarrierRecoveryRequestID(fact.OrganizationID, fact.AgentID, fact.Barrier.BarrierID)
	require.NoError(t, err)
	command := ports.RuntimeBarrierRebuildCommand{
		RequestID: requestID, OrganizationID: fact.OrganizationID, ActorPrincipalID: "agent-controller", AgentID: fact.AgentID,
		TemplateID: base.ConfiguredSpec.Snapshot.TemplateID, TemplateRevision: base.ConfiguredSpec.Snapshot.TemplateRevision,
	}
	// This independent six-field encoding pins the existing public fingerprint.
	payload, err := json.Marshal(struct {
		RequestID        string
		OrganizationID   string
		ActorPrincipalID string
		AgentID          string
		TemplateID       string
		TemplateRevision int64
	}{command.RequestID, command.OrganizationID, command.ActorPrincipalID, command.AgentID, command.TemplateID, command.TemplateRevision})
	require.NoError(t, err)
	digest := sha256.Sum256(payload)
	fingerprint := hex.EncodeToString(digest[:])
	now := time.Unix(1000, 0).UTC()
	acceptedAt := now.Add(27 * time.Second)
	receipt := ports.RuntimeBarrierRecoveryReceipt{
		Fact:    cloneRuntimeBarrierAdmissionApplicationIntent(ports.RuntimeBarrierRecoveryIntent{Fact: fact}).Fact,
		Policy:  domain.RuntimeBarrierRecoveryPolicy{OrganizationID: fact.OrganizationID, Revision: 7, Mode: "auto", CooldownMS: 60000},
		Command: command, RequestFingerprint: fingerprint, AcceptedAt: acceptedAt, CooldownUntil: acceptedAt.Add(time.Minute),
	}
	store := &runtimeBarrierAdmissionApplicationStore{
		rebuildLifecycleStoreStub: rebuildLifecycleStoreStub{base: base},
		receipt:                   cloneRuntimeBarrierAdmissionApplicationReceipt(receipt), replayFound: true,
	}
	specs := &runtimeBarrierAdmissionApplicationSpecs{lifecycleSpecSourceStub: lifecycleSpecSourceStub{template: template, model: model}}
	skills, client, effects := &runtimeBarrierAdmissionApplicationSkills{}, &skillPreparationClientStub{state: "ready"}, &runtimeBarrierAdmissionApplicationEffects{}
	lifecycle := newTestLifecycleService(specs, store, effects, effects, fixedClock{now: now},
		WithSkillPreparation(skills, client), WithLifecycleExecution(effects))
	fixture := &runtimeBarrierAdmissionApplicationFixture{
		store: store, specs: specs, skills: skills, client: client, effects: effects, lifecycle: lifecycle,
		service: NewRuntimeBarrierRecoveryAdmissionService(lifecycle, store),
		intent: ports.RuntimeBarrierRecoveryIntent{
			Fact: fact, ExpectedPolicyRevision: receipt.Policy.Revision,
			ExpectedOwnerUserID: base.Agent.OwnerUserID, ExpectedOwnerAuthorizationSequence: base.Agent.OwnerAuthorizationSequence,
			ExpectedIdentityRevocationSequence: base.Agent.IdentityRevocationSequence, Command: command,
		},
		receipt: receipt, now: now,
	}
	store.state = fixture.originalState(t, domain.OperationCompleted)
	t.Cleanup(func() {
		require.Empty(t, effects.calls, "admission does not execute Runtime, Egress or ACP settlement")
		require.Equal(t, 0, store.startCalls, "durable pending starts are left for a separate worker")
		require.Equal(t, 0, store.advanceCalls, "admission does not advance the lifecycle")
	})
	return fixture
}

func (fixture *runtimeBarrierAdmissionApplicationFixture) originalState(t *testing.T, operationState domain.OperationState) ports.AgentRebuildState {
	t.Helper()
	state := completedRebuildState(t, fixture.store.base)
	state.TargetSpec.ID = domain.DeriveResourceID("agentspec", "agentspec-rebuild", fixture.receipt.Command.RequestID)
	state.TargetSpec.CreatedAt = fixture.receipt.AcceptedAt
	state.Agent.AgentSpecRevisionID = state.TargetSpec.ID
	state.Operation.RequestID = fixture.receipt.Command.RequestID
	state.Operation.RequestFingerprint = fixture.receipt.RequestFingerprint
	state.Operation.TargetSpecRevisionID = state.TargetSpec.ID
	state.Operation.State = operationState
	state.Operation.CreatedAt, state.Operation.UpdatedAt = fixture.receipt.AcceptedAt, fixture.receipt.AcceptedAt
	deadline := fixture.receipt.AcceptedAt.Add(defaultDrainTimeout)
	state.Operation.DrainDeadlineAt = &deadline
	if operationState != domain.OperationCompleted {
		state.Agent = fixture.store.base.Agent
		state.Operation.Phase = domain.PhaseDrain
		state.Operation.ChildRequestID = domain.ChildRequestID(state.Operation.RequestID, domain.PhaseDrain)
	}
	state.Agent.UpdatedAt = fixture.receipt.AcceptedAt
	if operationState == domain.OperationRunning {
		state.Agent.ActiveOperationRequestID = state.Operation.RequestID
	}
	if operationState == domain.OperationFailed {
		state.Operation.ErrorCode = "fixture_drain_failure"
		state.Agent.FailureStage = string(domain.PhaseDrain)
		state.Agent.FailureCode = state.Operation.ErrorCode
	}
	return state
}

func (fixture *runtimeBarrierAdmissionApplicationFixture) assertNoPreparation(t *testing.T) {
	t.Helper()
	require.NotContains(t, fixture.store.calls, "lifecycle.base")
	require.Equal(t, 0, fixture.store.beginCalls)
	require.Empty(t, fixture.specs.calls)
	require.Equal(t, 0, fixture.skills.reads)
	require.Equal(t, 0, fixture.skills.reserved)
	require.Equal(t, 0, fixture.client.calls)
	require.Equal(t, 0, fixture.client.releases)
}

func cloneRuntimeBarrierAdmissionApplicationIntent(input ports.RuntimeBarrierRecoveryIntent) ports.RuntimeBarrierRecoveryIntent {
	if input.Fact.Barrier != nil {
		barrier := *input.Fact.Barrier
		input.Fact.Barrier = &barrier
	}
	return input
}

func cloneRuntimeBarrierAdmissionApplicationReceipt(receipt ports.RuntimeBarrierRecoveryReceipt) ports.RuntimeBarrierRecoveryReceipt {
	receipt.Fact = cloneRuntimeBarrierAdmissionApplicationIntent(ports.RuntimeBarrierRecoveryIntent{Fact: receipt.Fact}).Fact
	return receipt
}

func runtimeBarrierAdmissionApplicationCommandInput(command ports.RuntimeBarrierRebuildCommand) RebuildAgentInput {
	return RebuildAgentInput{RequestID: command.RequestID, OrganizationID: command.OrganizationID, ActorPrincipalID: command.ActorPrincipalID,
		AgentID: command.AgentID, TemplateID: command.TemplateID, TemplateRevision: command.TemplateRevision}
}

func runtimeBarrierAdmissionApplicationEventData(input map[string]any) map[string]any {
	copy := make(map[string]any, len(input))
	for key, value := range input {
		copy[key] = value
	}
	return copy
}
