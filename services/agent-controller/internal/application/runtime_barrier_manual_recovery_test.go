package application

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type manualRecoveryTestStore struct {
	*runtimeBarrierAdmissionApplicationStore
	policy         domain.RuntimeBarrierRecoveryPolicy
	policyErr      error
	policyKeys     []string
	afterReceipt   func()
	afterBase      func()
	afterPolicy    func()
	afterOperation func()
}

func (store *manualRecoveryTestStore) ReplayRuntimeBarrierRecovery(ctx context.Context, org, agent, barrier string) (ports.RuntimeBarrierRecoveryReceipt, bool, error) {
	receipt, found, err := store.runtimeBarrierAdmissionApplicationStore.ReplayRuntimeBarrierRecovery(ctx, org, agent, barrier)
	if store.afterReceipt != nil {
		store.afterReceipt()
	}
	return receipt, found, err
}

func (store *manualRecoveryTestStore) GetAgentLifecycleBase(ctx context.Context, agent string) (ports.AgentLifecycleBase, error) {
	base, err := store.runtimeBarrierAdmissionApplicationStore.GetAgentLifecycleBase(ctx, agent)
	if store.afterBase != nil {
		store.afterBase()
	}
	return base, err
}

func (store *manualRecoveryTestStore) GetRuntimeBarrierRecoveryPolicy(_ context.Context, org string) (domain.RuntimeBarrierRecoveryPolicy, error) {
	store.calls = append(store.calls, "recovery.policy")
	store.policyKeys = append(store.policyKeys, org)
	if store.afterPolicy != nil {
		store.afterPolicy()
	}
	return store.policy, store.policyErr
}

func (store *manualRecoveryTestStore) ReplayAgentRebuild(ctx context.Context, request, fingerprint string) (ports.AgentRebuildState, bool, error) {
	state, found, err := store.runtimeBarrierAdmissionApplicationStore.ReplayAgentRebuild(ctx, request, fingerprint)
	if store.afterOperation != nil {
		store.afterOperation()
	}
	return state, found, err
}

type manualRecoveryTestReader struct {
	store   *manualRecoveryTestStore
	fact    ports.RuntimeBarrierResult
	err     error
	queries []ports.RuntimeBarrierQuery
	after   func()
	read    func(context.Context, ports.RuntimeBarrierQuery) (ports.RuntimeBarrierResult, error)
}

func (reader *manualRecoveryTestReader) GetRuntimeBarrier(ctx context.Context, query ports.RuntimeBarrierQuery) (ports.RuntimeBarrierResult, error) {
	reader.store.calls = append(reader.store.calls, "acp.read")
	reader.queries = append(reader.queries, query)
	if reader.read != nil {
		return reader.read(ctx, query)
	}
	if reader.after != nil {
		reader.after()
	}
	return cloneRuntimeBarrierAdmissionApplicationIntent(ports.RuntimeBarrierRecoveryIntent{Fact: reader.fact}).Fact, reader.err
}

type manualRecoveryTestFixture struct {
	common  *runtimeBarrierAdmissionApplicationFixture
	store   *manualRecoveryTestStore
	reader  *manualRecoveryTestReader
	input   RuntimeBarrierManualRecoveryInput
	recover func(context.Context, RuntimeBarrierManualRecoveryInput) (RebuildAgentResult, error)
}

func newManualRecoveryTestFixture(t *testing.T, mode string) *manualRecoveryTestFixture {
	t.Helper()
	common := newRuntimeBarrierManualAdmissionFixture(t, mode)
	store := &manualRecoveryTestStore{
		runtimeBarrierAdmissionApplicationStore: common.store,
		policy:                                  common.receipt.Policy,
	}
	reader := &manualRecoveryTestReader{store: store,
		fact: cloneRuntimeBarrierAdmissionApplicationIntent(common.intent).Fact}
	common.lifecycle.store = store
	service := NewRuntimeBarrierManualRecoveryService(common.lifecycle, store, reader)
	return &manualRecoveryTestFixture{common: common, store: store, reader: reader,
		input: RuntimeBarrierManualRecoveryInput{
			Command:                 runtimeBarrierAdmissionApplicationCommandInput(common.intent.Command),
			BarrierID:               common.intent.Fact.Barrier.BarrierID,
			ExpectedRuntimeRevision: common.intent.Fact.RuntimeRevision,
		}, recover: service.Recover}
}

func (fixture *manualRecoveryTestFixture) assertNoPreparation(t *testing.T) {
	t.Helper()
	require.Zero(t, fixture.store.beginCalls)
	require.Empty(t, fixture.common.specs.calls)
	require.Zero(t, fixture.common.skills.reads)
	require.Zero(t, fixture.common.skills.reserved)
	require.Zero(t, fixture.common.client.calls)
	require.False(t, fixture.store.durable)
}

func (fixture *manualRecoveryTestFixture) replaceBarrier(t *testing.T, barrier string) {
	t.Helper()
	fixture.common.intent.Fact.Barrier.BarrierID = barrier
	request, err := ports.RuntimeBarrierRecoveryRequestID(fixture.input.Command.OrganizationID, fixture.input.Command.AgentID, barrier)
	require.NoError(t, err)
	fixture.common.intent.Command.RequestID = request
	fixture.common.receipt.Fact = cloneRuntimeBarrierAdmissionApplicationIntent(fixture.common.intent).Fact
	fixture.common.receipt.Command = fixture.common.intent.Command
	fixture.common.receipt.RequestFingerprint = runtimeBarrierManualAdmissionFingerprint(t, fixture.common.receipt.Command)
	fixture.store.receipt = cloneRuntimeBarrierAdmissionApplicationReceipt(fixture.common.receipt)
	fixture.store.state = fixture.common.originalState(t, domain.OperationCompleted)
	fixture.reader.fact = cloneRuntimeBarrierAdmissionApplicationIntent(fixture.common.intent).Fact
	fixture.input.Command.RequestID = request
	fixture.input.BarrierID = barrier
}

func TestRuntimeBarrierManualRecoveryRejectsInvalidInputBeforeDependencies(t *testing.T) {
	for _, scenario := range []struct {
		name string
		edit func(*RuntimeBarrierManualRecoveryInput)
	}{
		{"missing request", func(input *RuntimeBarrierManualRecoveryInput) { input.Command.RequestID = "" }},
		{"unstable request", func(input *RuntimeBarrierManualRecoveryInput) { input.Command.RequestID = "another-valid-request" }},
		{"missing organization", func(input *RuntimeBarrierManualRecoveryInput) { input.Command.OrganizationID = "" }},
		{"invalid organization", func(input *RuntimeBarrierManualRecoveryInput) { input.Command.OrganizationID = "org/foreign" }},
		{"missing actor", func(input *RuntimeBarrierManualRecoveryInput) { input.Command.ActorPrincipalID = "" }},
		{"invalid actor", func(input *RuntimeBarrierManualRecoveryInput) { input.Command.ActorPrincipalID = "admin/1" }},
		{"missing Agent", func(input *RuntimeBarrierManualRecoveryInput) { input.Command.AgentID = "" }},
		{"invalid Agent", func(input *RuntimeBarrierManualRecoveryInput) { input.Command.AgentID = "agent/foreign" }},
		{"missing template", func(input *RuntimeBarrierManualRecoveryInput) { input.Command.TemplateID = "" }},
		{"invalid template", func(input *RuntimeBarrierManualRecoveryInput) { input.Command.TemplateID = "template/foreign" }},
		{"zero template revision", func(input *RuntimeBarrierManualRecoveryInput) { input.Command.TemplateRevision = 0 }},
		{"missing barrier", func(input *RuntimeBarrierManualRecoveryInput) { input.BarrierID = "" }},
		{"whitespace barrier", func(input *RuntimeBarrierManualRecoveryInput) { input.BarrierID = "barrier with space" }},
		{"oversized barrier", func(input *RuntimeBarrierManualRecoveryInput) { input.BarrierID = strings.Repeat("界", 201) }},
		{"missing runtime", func(input *RuntimeBarrierManualRecoveryInput) { input.ExpectedRuntimeRevision = "" }},
		{"invalid runtime", func(input *RuntimeBarrierManualRecoveryInput) { input.ExpectedRuntimeRevision = "runtime/foreign" }},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			fixture := newManualRecoveryTestFixture(t, "manual")
			scenario.edit(&fixture.input)
			before := fixture.input
			result, err := fixture.recover(context.Background(), fixture.input)
			require.ErrorIs(t, err, ErrInvalidInput)
			require.Equal(t, RebuildAgentResult{}, result)
			require.Equal(t, before, fixture.input)
			require.Empty(t, fixture.store.calls)
			fixture.assertNoPreparation(t)
		})
	}
}

func TestRuntimeBarrierManualRecoveryReplaysOriginalAcrossSourcesAndAdministrators(t *testing.T) {
	for _, originalManual := range []bool{false, true} {
		origin := "auto"
		if originalManual {
			origin = "manual"
		}
		for _, state := range []domain.OperationState{domain.OperationRunning, domain.OperationCompleted, domain.OperationFailed} {
			t.Run(origin+"/"+string(state), func(t *testing.T) {
				fixture := newManualRecoveryTestFixture(t, "manual")
				fixture.common.receipt.Manual = originalManual
				if !originalManual {
					fixture.common.receipt.Command.ActorPrincipalID = "agent-controller"
					fixture.common.receipt.Policy.Mode = "auto"
				}
				fixture.common.receipt.RequestFingerprint = runtimeBarrierManualAdmissionFingerprint(t, fixture.common.receipt.Command)
				fixture.store.receipt = cloneRuntimeBarrierAdmissionApplicationReceipt(fixture.common.receipt)
				fixture.store.receiptPresent = true
				fixture.store.state = fixture.common.originalState(t, state)
				fixture.input.Command.ActorPrincipalID = "another-current-administrator"
				fixture.store.baseErr = errors.New("replay must not read current base")
				fixture.store.policyErr = errors.New("replay must not read current policy")
				fixture.reader.err = errors.New("replay must not query ACP")
				beforeReceipt := cloneRuntimeBarrierAdmissionApplicationReceipt(fixture.store.receipt)
				beforeState, err := json.Marshal(fixture.store.state)
				require.NoError(t, err)
				beforeInput := fixture.input

				result, err := fixture.recover(context.Background(), fixture.input)

				require.NoError(t, err)
				require.Equal(t, beforeReceipt.Command.RequestID, result.Operation.RequestID)
				require.Equal(t, state, result.Operation.State)
				require.Equal(t, fixture.store.state.Operation.Phase, result.Operation.Phase)
				require.Equal(t, beforeReceipt.AcceptedAt, result.Operation.CreatedAt)
				require.Equal(t, fixture.input.Command.AgentID, result.Agent.AgentID)
				require.Equal(t, []string{"recovery.replay", "lifecycle.replay"}, fixture.store.calls)
				require.Equal(t, [][3]string{{fixture.input.Command.OrganizationID, fixture.input.Command.AgentID, fixture.input.BarrierID}}, fixture.store.receiptKeys)
				require.Equal(t, [][2]string{{beforeReceipt.Command.RequestID, beforeReceipt.RequestFingerprint}}, fixture.store.replayKeys, "replay uses the original command, not a fingerprint of the current administrator")
				require.Equal(t, beforeReceipt, fixture.store.receipt)
				afterState, err := json.Marshal(fixture.store.state)
				require.NoError(t, err)
				require.Equal(t, beforeState, afterState)
				require.Equal(t, beforeInput, fixture.input)
				fixture.common.assertNoPreparation(t)
				require.Empty(t, fixture.reader.queries)
				require.Empty(t, fixture.store.policyKeys)
			})
		}
	}
}

func TestRuntimeBarrierManualRecoveryRejectsStaleReplayTargetsWithoutCurrentReads(t *testing.T) {
	for _, scenario := range []struct {
		name string
		edit func(*RuntimeBarrierManualRecoveryInput)
	}{
		{"original Runtime", func(input *RuntimeBarrierManualRecoveryInput) { input.ExpectedRuntimeRevision = "another-runtime" }},
		{"original template", func(input *RuntimeBarrierManualRecoveryInput) { input.Command.TemplateID = "another-template" }},
		{"original template revision", func(input *RuntimeBarrierManualRecoveryInput) { input.Command.TemplateRevision++ }},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			fixture := newManualRecoveryTestFixture(t, "manual")
			fixture.store.receiptPresent = true
			scenario.edit(&fixture.input)
			result, err := fixture.recover(context.Background(), fixture.input)
			require.ErrorIs(t, err, ErrLifecycleConflict)
			require.Equal(t, RebuildAgentResult{}, result)
			require.NotContains(t, fixture.store.calls, "lifecycle.base")
			require.Empty(t, fixture.reader.queries)
			require.Empty(t, fixture.store.policyKeys)
			fixture.assertNoPreparation(t)
		})
	}
}

func TestRuntimeBarrierManualRecoveryRejectsCorruptStoredReceipts(t *testing.T) {
	for _, scenario := range []struct {
		name string
		edit func(*manualRecoveryTestFixture)
	}{
		{"foreign organization", func(f *manualRecoveryTestFixture) { f.store.receipt.Fact.OrganizationID = "foreign-org" }},
		{"foreign Agent", func(f *manualRecoveryTestFixture) { f.store.receipt.Fact.AgentID = "foreign-agent" }},
		{"other barrier", func(f *manualRecoveryTestFixture) { f.store.receipt.Fact.Barrier.BarrierID = "foreign-barrier" }},
		{"fingerprint", func(f *manualRecoveryTestFixture) { f.store.receipt.RequestFingerprint = strings.Repeat("b", 64) }},
		{"unknown policy", func(f *manualRecoveryTestFixture) { f.store.receipt.Policy.Mode = "automatic" }},
		{"changed cooldown", func(f *manualRecoveryTestFixture) {
			f.store.receipt.CooldownUntil = f.store.receipt.CooldownUntil.Add(time.Second)
		}},
		{"missing operation", func(f *manualRecoveryTestFixture) { f.store.replayFound = false }},
		{"wrong operation source", func(f *manualRecoveryTestFixture) { f.store.state.Operation.SourceRuntimeRevision = "another-runtime" }},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			fixture := newManualRecoveryTestFixture(t, "manual")
			fixture.store.receiptPresent = true
			scenario.edit(fixture)
			result, err := fixture.recover(context.Background(), fixture.input)
			require.ErrorIs(t, err, ErrQueryContract)
			require.Equal(t, RebuildAgentResult{}, result)
			require.Empty(t, fixture.reader.queries)
			require.Empty(t, fixture.store.policyKeys)
			fixture.common.assertNoPreparation(t)
		})
	}
}

func TestRuntimeBarrierManualRecoveryNewRequestUsesCommonAdmissionInEveryMode(t *testing.T) {
	for _, mode := range []string{"manual", "notify", "auto"} {
		t.Run(mode, func(t *testing.T) {
			fixture := newManualRecoveryTestFixture(t, mode)
			before := fixture.input
			result, err := fixture.recover(context.Background(), fixture.input)
			require.NoError(t, err)
			require.Equal(t, before, fixture.input)
			require.Equal(t, fixture.common.intent.Command.RequestID, result.Operation.RequestID)
			require.Equal(t, fixture.store.state.Operation.State, result.Operation.State)
			require.Equal(t, fixture.common.receipt.AcceptedAt, result.Operation.CreatedAt)
			require.Equal(t, []ports.RuntimeBarrierQuery{{OrganizationID: before.Command.OrganizationID, AgentID: before.Command.AgentID, ExpectedRuntimeRevision: before.ExpectedRuntimeRevision}}, fixture.reader.queries)
			require.Equal(t, []string{before.Command.OrganizationID}, fixture.store.policyKeys)
			require.Equal(t, "recovery.replay", fixture.store.calls[0])
			require.Equal(t, 1, fixture.store.beginCalls)
			require.NotNil(t, fixture.store.begin.Recovery)
			require.True(t, fixture.store.begin.Recovery.Manual)
			require.Equal(t, fixture.common.intent, *fixture.store.begin.Recovery)
			require.Equal(t, "admin-1", fixture.store.begin.Recovery.Command.ActorPrincipalID)
			require.Equal(t, fixture.common.receipt.RequestFingerprint, fixture.store.begin.Operation.RequestFingerprint)
			require.Equal(t, 1, fixture.common.skills.reserved)
			require.Equal(t, 1, fixture.common.client.calls)
		})
	}
	t.Run("opaque NUL barrier is preserved", func(t *testing.T) {
		fixture := newManualRecoveryTestFixture(t, "manual")
		fixture.replaceBarrier(t, "barrier\x00原/e\u0301-🧪")
		result, err := fixture.recover(context.Background(), fixture.input)
		require.NoError(t, err)
		require.Equal(t, fixture.input.Command.RequestID, result.Operation.RequestID)
		require.Equal(t, fixture.input.BarrierID, fixture.store.receiptKeys[0][2])
		require.Equal(t, fixture.input.BarrierID, fixture.store.begin.Recovery.Fact.Barrier.BarrierID)
	})
}

func TestRuntimeBarrierManualRecoveryRejectsChangedConfiguredSourceBeforeACP(t *testing.T) {
	for _, scenario := range []struct {
		name string
		edit func(*manualRecoveryTestFixture)
		want error
	}{
		{"foreign organization", func(f *manualRecoveryTestFixture) { f.store.base.Agent.OrganizationID = "foreign-org" }, ErrAgentNotFound},
		{"source Runtime", func(f *manualRecoveryTestFixture) { f.store.base.Agent.RuntimeRevision = "another-runtime" }, ErrLifecycleConflict},
		{"configured template", func(f *manualRecoveryTestFixture) {
			f.store.base.ConfiguredSpec.Snapshot.TemplateID = "another-template"
		}, ErrLifecycleConflict},
		{"configured revision", func(f *manualRecoveryTestFixture) { f.store.base.ConfiguredSpec.Snapshot.TemplateRevision++ }, ErrLifecycleConflict},
		{"active operation", func(f *manualRecoveryTestFixture) { f.store.base.Agent.ActiveOperationRequestID = "another-operation" }, ErrLifecycleConflict},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			fixture := newManualRecoveryTestFixture(t, "manual")
			scenario.edit(fixture)
			result, err := fixture.recover(context.Background(), fixture.input)
			require.ErrorIs(t, err, scenario.want)
			require.Equal(t, RebuildAgentResult{}, result)
			require.Empty(t, fixture.reader.queries)
			require.Empty(t, fixture.store.policyKeys)
			fixture.assertNoPreparation(t)
		})
	}
}

func TestRuntimeBarrierManualRecoveryRejectsMissingChangedAndCorruptFacts(t *testing.T) {
	for _, scenario := range []struct {
		name string
		edit func(*manualRecoveryTestFixture)
		want error
	}{
		{"cleared barrier", func(f *manualRecoveryTestFixture) { f.reader.fact.Barrier = nil }, ErrLifecycleConflict},
		{"another barrier", func(f *manualRecoveryTestFixture) { f.reader.fact.Barrier.BarrierID = "another-barrier" }, ErrLifecycleConflict},
		{"foreign organization", func(f *manualRecoveryTestFixture) { f.reader.fact.OrganizationID = "foreign-org" }, ErrQueryContract},
		{"foreign Agent", func(f *manualRecoveryTestFixture) { f.reader.fact.AgentID = "foreign-agent" }, ErrQueryContract},
		{"wrong queried Runtime", func(f *manualRecoveryTestFixture) { f.reader.fact.RuntimeRevision = "another-runtime" }, ErrQueryContract},
		{"invalid barrier", func(f *manualRecoveryTestFixture) { f.reader.fact.Barrier.BarrierID = "barrier with space" }, ErrQueryContract},
		{"wrong reason", func(f *manualRecoveryTestFixture) { f.reader.fact.Barrier.Reason = "agent_unavailable" }, ErrQueryContract},
		{"missing original execution", func(f *manualRecoveryTestFixture) { f.reader.fact.Barrier.RuntimeExecutionID = "" }, ErrQueryContract},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			fixture := newManualRecoveryTestFixture(t, "manual")
			scenario.edit(fixture)
			result, err := fixture.recover(context.Background(), fixture.input)
			require.ErrorIs(t, err, scenario.want)
			require.Equal(t, RebuildAgentResult{}, result)
			require.Len(t, fixture.reader.queries, 1)
			require.Empty(t, fixture.store.policyKeys)
			fixture.assertNoPreparation(t)
		})
	}
	for _, mode := range []string{"foreign organization", "unknown mode"} {
		t.Run("policy/"+mode, func(t *testing.T) {
			fixture := newManualRecoveryTestFixture(t, "manual")
			if mode == "foreign organization" {
				fixture.store.policy.OrganizationID = "foreign-org"
			} else {
				fixture.store.policy.Mode = "automatic"
			}
			result, err := fixture.recover(context.Background(), fixture.input)
			require.ErrorIs(t, err, ErrQueryContract)
			require.Equal(t, RebuildAgentResult{}, result)
			fixture.assertNoPreparation(t)
		})
	}
}

func TestRuntimeBarrierManualRecoveryDependencyErrorsStopAtTheirBoundary(t *testing.T) {
	for _, boundary := range []string{"receipt", "base", "ACP", "policy", "operation"} {
		t.Run(boundary, func(t *testing.T) {
			fixture := newManualRecoveryTestFixture(t, "manual")
			cause := errors.New("original " + boundary + " dependency failure")
			last := ""
			switch boundary {
			case "receipt":
				fixture.store.reads = []runtimeBarrierAdmissionApplicationRead{{err: cause}}
				last = "recovery.replay"
			case "base":
				fixture.store.baseErr = cause
				last = "lifecycle.base"
			case "ACP":
				fixture.reader.err = cause
				last = "acp.read"
			case "policy":
				fixture.store.policyErr = cause
				last = "recovery.policy"
			case "operation":
				fixture.store.receiptPresent = true
				fixture.store.replayErr = cause
				last = "lifecycle.replay"
			}
			result, err := fixture.recover(context.Background(), fixture.input)
			require.ErrorIs(t, err, cause)
			require.Equal(t, RebuildAgentResult{}, result)
			require.NotEmpty(t, fixture.store.calls)
			require.Equal(t, last, fixture.store.calls[len(fixture.store.calls)-1])
			fixture.assertNoPreparation(t)
		})
	}
}

func TestRuntimeBarrierManualRecoveryCancellationStopsFurtherCalls(t *testing.T) {
	for _, boundary := range []string{"before read", "receipt miss", "receipt hit", "base", "ACP", "policy", "operation"} {
		t.Run(boundary, func(t *testing.T) {
			fixture := newManualRecoveryTestFixture(t, "manual")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			last := ""
			switch boundary {
			case "before read":
				cancel()
			case "receipt miss", "receipt hit":
				fixture.store.receiptPresent = boundary == "receipt hit"
				fixture.store.afterReceipt = cancel
				last = "recovery.replay"
			case "base":
				fixture.store.afterBase = cancel
				last = "lifecycle.base"
			case "ACP":
				fixture.reader.after = cancel
				last = "acp.read"
			case "policy":
				fixture.store.afterPolicy = cancel
				last = "recovery.policy"
			case "operation":
				fixture.store.receiptPresent = true
				fixture.store.afterOperation = cancel
				last = "lifecycle.replay"
			}
			result, err := fixture.recover(ctx, fixture.input)
			require.ErrorIs(t, err, context.Canceled)
			require.Equal(t, RebuildAgentResult{}, result)
			if last == "" {
				require.Empty(t, fixture.store.calls)
			} else {
				require.Equal(t, last, fixture.store.calls[len(fixture.store.calls)-1])
			}
			fixture.assertNoPreparation(t)
		})
	}
}

func TestRuntimeBarrierManualRecoveryCancellationJoinsHeldACPRead(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		fixture := newManualRecoveryTestFixture(t, "manual")
		ctx, cancel := context.WithCancel(context.Background())
		entered, cancelled, released, done := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
		fixture.reader.read = func(ctx context.Context, _ ports.RuntimeBarrierQuery) (ports.RuntimeBarrierResult, error) {
			close(entered)
			<-ctx.Done()
			close(cancelled)
			<-released
			return fixture.reader.fact, nil
		}
		var result RebuildAgentResult
		var failure error
		go func() {
			defer close(done)
			result, failure = fixture.recover(ctx, fixture.input)
		}()
		release := false
		defer func() {
			cancel()
			if !release {
				close(released)
			}
			<-done
		}()
		select {
		case <-entered:
		case <-done:
			t.Fatal("manual recovery never entered its actual ACP read")
		}
		cancel()
		<-cancelled
		synctest.Wait()
		select {
		case <-done:
			t.Fatal("manual recovery returned before the held ACP dependency settled")
		default:
		}
		close(released)
		release = true
		<-done
		require.ErrorIs(t, failure, context.Canceled)
		require.Equal(t, RebuildAgentResult{}, result)
		require.Empty(t, fixture.store.policyKeys)
		fixture.assertNoPreparation(t)
	})
}

func TestRuntimeBarrierManualRecoveryReplaysReceiptCommittedAfterInitialMiss(t *testing.T) {
	for _, originalManual := range []bool{false, true} {
		origin := "auto"
		if originalManual {
			origin = "manual"
		}
		for _, boundary := range []struct {
			name string
			edit func(*manualRecoveryTestFixture)
			acp  bool
		}{
			{"active operation", func(f *manualRecoveryTestFixture) {
				f.store.base.Agent.ActiveOperationRequestID = f.common.receipt.Command.RequestID
			}, false},
			{"replaced Runtime", func(f *manualRecoveryTestFixture) {
				f.store.base.Agent.RuntimeRevision = "replacement-runtime"
			}, false},
			{"changed Template", func(f *manualRecoveryTestFixture) {
				f.store.base.ConfiguredSpec.Snapshot.TemplateID = "replacement-template"
			}, false},
			{"cleared ACP barrier", func(f *manualRecoveryTestFixture) {
				f.reader.fact.Barrier = nil
			}, true},
			{"different ACP barrier", func(f *manualRecoveryTestFixture) {
				f.reader.fact.Barrier.BarrierID = "replacement-barrier"
			}, true},
		} {
			for _, request := range []struct {
				name string
				edit func(*RuntimeBarrierManualRecoveryInput)
			}{
				{"original request", nil},
				{"wrong original Runtime", func(input *RuntimeBarrierManualRecoveryInput) {
					input.ExpectedRuntimeRevision = "another-original-runtime"
				}},
				{"wrong original Template", func(input *RuntimeBarrierManualRecoveryInput) {
					input.Command.TemplateID = "another-original-template"
				}},
				{"wrong original Template revision", func(input *RuntimeBarrierManualRecoveryInput) {
					input.Command.TemplateRevision++
				}},
			} {
				t.Run(origin+"/"+boundary.name+"/"+request.name, func(t *testing.T) {
					fixture := newManualRecoveryTestFixture(t, "auto")
					fixture.common.receipt.Manual = originalManual
					if !originalManual {
						fixture.common.receipt.Command.ActorPrincipalID = "agent-controller"
					}
					fixture.common.receipt.RequestFingerprint = runtimeBarrierManualAdmissionFingerprint(t, fixture.common.receipt.Command)
					original := cloneRuntimeBarrierAdmissionApplicationReceipt(fixture.common.receipt)
					fixture.store.receipt = cloneRuntimeBarrierAdmissionApplicationReceipt(original)
					fixture.store.state = fixture.common.originalState(t, domain.OperationRunning)
					beforeState, err := json.Marshal(fixture.store.state)
					require.NoError(t, err)
					fixture.input.Command.ActorPrincipalID = "another-current-administrator"
					if request.edit != nil {
						request.edit(&fixture.input)
					}
					beforeInput := fixture.input
					receiptReads := 0
					committedAfterMiss := false
					fixture.store.afterReceipt = func() {
						receiptReads++
						if receiptReads != 1 {
							return
						}
						// The first read has already captured its miss. Publish the
						// other admission's original before the preflight continues.
						require.False(t, fixture.store.receiptPresent)
						fixture.store.receipt = cloneRuntimeBarrierAdmissionApplicationReceipt(original)
						fixture.store.receiptPresent = true
						committedAfterMiss = true
						boundary.edit(fixture)
					}

					result, err := fixture.recover(context.Background(), fixture.input)

					require.True(t, committedAfterMiss)
					require.Contains(t, fixture.store.calls, "lifecycle.base")
					fixture.assertNoPreparation(t)
					require.Equal(t, beforeInput, fixture.input)
					require.Equal(t, original, fixture.store.receipt, "recovery must retain the original actor, fingerprint, policy and cooldown")
					afterState, marshalErr := json.Marshal(fixture.store.state)
					require.NoError(t, marshalErr)
					require.Equal(t, beforeState, afterState)
					if request.edit != nil {
						require.ErrorIs(t, err, ErrLifecycleConflict)
						require.Equal(t, RebuildAgentResult{}, result)
					} else {
						require.NoError(t, err, "a concurrently committed original tuple must win over changed preflight state")
						require.Equal(t, rebuildAgentResult(fixture.store.state), result)
						if boundary.acp {
							require.Len(t, fixture.reader.queries, 1, "the changed ACP fact must actually be read")
						} else {
							require.Empty(t, fixture.reader.queries)
						}
					}
					key := [3]string{beforeInput.Command.OrganizationID, beforeInput.Command.AgentID, beforeInput.BarrierID}
					require.Equal(t, [][3]string{key, key}, fixture.store.receiptKeys, "preflight failure must re-read the original tuple")
					require.Equal(t, [][2]string{{original.Command.RequestID, original.RequestFingerprint}}, fixture.store.replayKeys)
					require.Empty(t, fixture.store.policyKeys)
				})
			}
		}
	}
}
