package application

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type recoveryProjectionObservationStore struct {
	*barrierObservationStore
	revision      int64
	revisionErr   error
	revisionKeys  [][2]string
	afterRevision func()
	records       []ports.RecordRuntimeBarrierObservation
	record        func(context.Context, ports.RecordRuntimeBarrierObservation) error
}

func (store *recoveryProjectionObservationStore) GetRuntimeBarrierObservationRevision(ctx context.Context, org, agent string) (int64, error) {
	store.fixture.calls.record(ctx, "stamp", agent, nil)
	store.revisionKeys = append(store.revisionKeys, [2]string{org, agent})
	if store.afterRevision != nil {
		store.afterRevision()
	}
	return store.revision, store.revisionErr
}

func (store *recoveryProjectionObservationStore) RecordRuntimeBarrierObservation(ctx context.Context, input ports.RecordRuntimeBarrierObservation) error {
	copy := input
	if input.Fact.Barrier != nil {
		barrier := *input.Fact.Barrier
		copy.Fact.Barrier = &barrier
	}
	store.records = append(store.records, copy)
	store.fixture.calls.record(ctx, "record", input.ExpectedAgent.AgentID, nil)
	if store.record != nil {
		return store.record(ctx, input)
	}
	return nil
}

func projectionObservationWorker(t *testing.T, fixture *barrierObservationFixture, store *recoveryProjectionObservationStore) *RuntimeBarrierRecoveryObservationWorker {
	t.Helper()
	worker, err := NewRuntimeBarrierRecoveryObservationWorker(store, fixture.reader, fixture.admitter,
		barrierObservationSchedule(2), slog.New(slog.NewTextHandler(io.Discard, nil)))
	require.NoError(t, err)
	return worker
}

func TestRuntimeBarrierRecoveryProjectionRecordsBeforeModeSpecificAdmission(t *testing.T) {
	for _, mode := range []string{"auto", "notify", "manual"} {
		t.Run(mode, func(t *testing.T) {
			fixture := newBarrierObservationFixture(1)
			agent := fixture.bases[fixture.agents[0].AgentID].Agent
			fixture.agents[0].OwnerUserID = "stale-list-owner"
			fixture.agents[0].RuntimeRevision = "stale-list-runtime"
			fixture.store.policy = func(_ context.Context, org string) (domain.RuntimeBarrierRecoveryPolicy, error) {
				policy := barrierObservationPolicy(org)
				policy.Mode = mode
				return policy, nil
			}
			store := &recoveryProjectionObservationStore{barrierObservationStore: fixture.store, revision: 7}
			worker := projectionObservationWorker(t, fixture, store)

			require.NoError(t, worker.RunOnce(context.Background()))

			require.Equal(t, [][2]string{{agent.OrganizationID, agent.AgentID}}, store.revisionKeys)
			require.Len(t, store.records, 1)
			require.Equal(t, ports.RecordRuntimeBarrierObservation{
				Fact: barrierObservationFact(ports.RuntimeBarrierQuery{OrganizationID: agent.OrganizationID,
					AgentID: agent.AgentID, ExpectedRuntimeRevision: agent.RuntimeRevision}),
				ExpectedAgent: agent, ExpectedPolicyRevision: 9, ExpectedObservationRevision: 7,
			}, store.records[0], "persist the authoritative source and the original opaque fact without normalization")
			snapshot := fixture.calls.snapshot()
			expected := []string{"list:", "base:" + agent.AgentID, "stamp:" + agent.AgentID,
				"barrier:" + agent.AgentID, "policy:" + agent.OrganizationID, "record:" + agent.AgentID}
			if mode == "auto" {
				expected = append(expected, "admit:"+agent.AgentID)
				require.Len(t, snapshot.intents, 1)
				require.Equal(t, store.records[0].Fact, snapshot.intents[0].Fact)
			} else {
				require.Empty(t, snapshot.intents, "persisting notify/manual observations cannot start Rebuild")
			}
			require.Equal(t, expected, snapshot.events)
			deadline, bounded := snapshot.contexts[0].Deadline()
			require.True(t, bounded)
			for _, ctx := range snapshot.contexts {
				actual, bounded := ctx.Deadline()
				require.True(t, bounded)
				require.Equal(t, deadline, actual, "stamp and Record share the original round budget")
			}
		})
	}
}

func TestRuntimeBarrierRecoveryProjectionRecordsAnAuthoritativeNullWithoutAdmission(t *testing.T) {
	fixture := newBarrierObservationFixture(1)
	agent := fixture.bases[fixture.agents[0].AgentID].Agent
	fixture.reader.read = func(_ context.Context, query ports.RuntimeBarrierQuery) (ports.RuntimeBarrierResult, error) {
		fact := barrierObservationFact(query)
		fact.Barrier = nil
		return fact, nil
	}
	store := &recoveryProjectionObservationStore{barrierObservationStore: fixture.store, revision: 7}

	require.NoError(t, projectionObservationWorker(t, fixture, store).RunOnce(context.Background()))

	require.Len(t, store.records, 1, "a matching null must reach the CAS-protected durable clear, not disappear in the worker")
	require.Equal(t, agent, store.records[0].ExpectedAgent)
	require.EqualValues(t, 7, store.records[0].ExpectedObservationRevision)
	require.Equal(t, ports.RuntimeBarrierResult{OrganizationID: agent.OrganizationID,
		AgentID: agent.AgentID, RuntimeRevision: agent.RuntimeRevision}, store.records[0].Fact)
	require.Empty(t, fixture.calls.snapshot().intents)
}

func TestRuntimeBarrierRecoveryProjectionNeverRecordsFailedOrMismatchedReads(t *testing.T) {
	for _, scenario := range []string{"ACP error", "foreign organization", "foreign Agent", "wrong Runtime", "invalid barrier"} {
		t.Run(scenario, func(t *testing.T) {
			fixture := newBarrierObservationFixture(1)
			cause := errors.New("original ACP observation failure")
			fixture.reader.read = func(_ context.Context, query ports.RuntimeBarrierQuery) (ports.RuntimeBarrierResult, error) {
				fact := barrierObservationFact(query)
				switch scenario {
				case "ACP error":
					return fact, cause
				case "foreign organization":
					fact.OrganizationID = "foreign-org"
				case "foreign Agent":
					fact.AgentID = "foreign-agent"
				case "wrong Runtime":
					fact.RuntimeRevision = "other-runtime"
				case "invalid barrier":
					fact.Barrier.BarrierID = "invalid barrier"
				}
				return fact, nil
			}
			store := &recoveryProjectionObservationStore{barrierObservationStore: fixture.store, revision: 7}
			err := projectionObservationWorker(t, fixture, store).RunOnce(context.Background())
			if scenario == "ACP error" {
				require.ErrorIs(t, err, cause)
			} else {
				require.ErrorIs(t, err, ErrQueryContract)
			}
			require.Empty(t, store.records)
			require.Empty(t, fixture.calls.snapshot().intents)
		})
	}
}

func TestRuntimeBarrierRecoveryProjectionPersistenceErrorsPreventAdmission(t *testing.T) {
	for _, boundary := range []string{"stamp", "Record"} {
		t.Run(boundary, func(t *testing.T) {
			fixture := newBarrierObservationFixture(1)
			cause := errors.New("original observation persistence failure")
			store := &recoveryProjectionObservationStore{barrierObservationStore: fixture.store, revision: 7}
			if boundary == "stamp" {
				store.revisionErr = cause
			} else {
				store.record = func(context.Context, ports.RecordRuntimeBarrierObservation) error { return cause }
			}
			err := projectionObservationWorker(t, fixture, store).RunOnce(context.Background())
			require.ErrorIs(t, err, cause)
			require.Empty(t, fixture.calls.snapshot().intents)
			if boundary == "stamp" {
				require.Empty(t, fixture.calls.snapshot().queries)
				require.Empty(t, store.records)
			} else {
				require.Len(t, store.records, 1)
			}
		})
	}
}

func TestRuntimeBarrierRecoveryProjectionCancellationStopsLaterCalls(t *testing.T) {
	for _, boundary := range []string{"stamp", "ACP", "policy", "Record"} {
		t.Run(boundary, func(t *testing.T) {
			fixture := newBarrierObservationFixture(1)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			store := &recoveryProjectionObservationStore{barrierObservationStore: fixture.store, revision: 7}
			switch boundary {
			case "stamp":
				store.afterRevision = cancel
			case "ACP":
				fixture.reader.read = func(_ context.Context, query ports.RuntimeBarrierQuery) (ports.RuntimeBarrierResult, error) {
					cancel()
					return barrierObservationFact(query), nil
				}
			case "policy":
				fixture.store.policy = func(_ context.Context, org string) (domain.RuntimeBarrierRecoveryPolicy, error) {
					cancel()
					return barrierObservationPolicy(org), nil
				}
			case "Record":
				store.record = func(context.Context, ports.RecordRuntimeBarrierObservation) error { cancel(); return nil }
			}
			err := projectionObservationWorker(t, fixture, store).RunOnce(ctx)
			require.ErrorIs(t, err, context.Canceled)
			require.Empty(t, fixture.calls.snapshot().intents)
			if boundary == "Record" {
				require.Len(t, store.records, 1)
			} else {
				require.Empty(t, store.records)
			}
			if boundary == "stamp" {
				require.Empty(t, fixture.calls.snapshot().queries)
			}
		})
	}
}

func TestRuntimeBarrierRecoveryProjectionCancellationJoinsActualRecord(t *testing.T) {
	for _, termination := range []string{"parent cancellation", "round deadline"} {
		t.Run(termination, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				fixture := newBarrierObservationFixture(1)
				hold := newBarrierObservationHold()
				store := &recoveryProjectionObservationStore{barrierObservationStore: fixture.store, revision: 7,
					record: func(ctx context.Context, _ ports.RecordRuntimeBarrierObservation) error { hold.wait(ctx); return nil }}
				ctx, cancel := context.WithCancel(context.Background())
				worker := projectionObservationWorker(t, fixture, store)
				task := startBarrierObservationTask(func() error { return worker.RunOnce(ctx) })
				defer func() {
					cancel()
					hold.release()
					hold.joinIfStarted(t)
					_ = task.join(t)
				}()
				waitBarrierObservationHeld(t, hold, task)
				if termination == "parent cancellation" {
					cancel()
				}
				<-hold.cancelled
				synctest.Wait()
				select {
				case <-task.done:
					t.Fatal("worker returned while its original Record callback was still held")
				default:
				}
				require.Empty(t, fixture.calls.snapshot().intents)
				hold.release()
				err := task.join(t)
				if termination == "parent cancellation" {
					require.ErrorIs(t, err, context.Canceled)
				} else {
					require.ErrorIs(t, err, context.DeadlineExceeded)
				}
				requireBarrierObservationClosed(t, hold.returned, "actual Record did not return before worker join")
				require.Empty(t, fixture.calls.snapshot().intents)
			})
		})
	}
}

type recoveryProjectionQueryStore struct {
	*agentQueryStoreStub
	projection *ports.RuntimeBarrierRecoveryProjection
	err        error
	reads      []ports.AgentRecord
	afterRead  func()
}

func (store *recoveryProjectionQueryStore) GetRuntimeBarrierRecoveryProjection(_ context.Context, agent ports.AgentRecord) (*ports.RuntimeBarrierRecoveryProjection, error) {
	store.reads = append(store.reads, agent)
	if store.afterRead != nil {
		store.afterRead()
	}
	return store.projection, store.err
}

func recoveryProjectionQueryFixture(t *testing.T) *recoveryProjectionQueryStore {
	t.Helper()
	agent := queryAgentRecord("agent-1", "owner-1", domain.AgentCreated, time.Unix(1, 0).UTC())
	agent.ActivationState, agent.RuntimeState = domain.ActivationEnabled, domain.RuntimeAvailable
	agent.AgentSpecRevisionID, agent.RuntimeRevision = "spec-1", "runtime-1"
	agent.OwnerAuthorizationSequence, agent.IdentityRevocationSequence = 20, 10
	barrier := "barrier\x00原/e\u0301-🧪"
	request, err := ports.RuntimeBarrierRecoveryRequestID(agent.OrganizationID, agent.AgentID, barrier)
	require.NoError(t, err)
	notification, err := ports.RuntimeBarrierNotificationID(agent.OrganizationID, agent.AgentID, barrier)
	require.NoError(t, err)
	return &recoveryProjectionQueryStore{
		agentQueryStoreStub: &agentQueryStoreStub{record: agent, configuration: ports.AgentConfigurationRecord{
			AgentID: agent.AgentID, AgentSpecRevisionID: agent.AgentSpecRevisionID}},
		projection: &ports.RuntimeBarrierRecoveryProjection{BarrierID: barrier, Reason: ports.ExecutionRuntimeBarrierRequired,
			RuntimeRevision: agent.RuntimeRevision, PolicyRevision: 0, Mode: "manual", CooldownMS: 300000,
			RebuildRequestID: request, NotificationID: notification},
	}
}

func TestRuntimeBarrierRecoveryProjectionQueryPreservesOptionalReadOnlyWire(t *testing.T) {
	for _, present := range []bool{false, true} {
		t.Run(map[bool]string{false: "absent", true: "present"}[present], func(t *testing.T) {
			store := recoveryProjectionQueryFixture(t)
			if !present {
				store.projection = nil
			}
			before := store.record
			var expected *ports.RuntimeBarrierRecoveryProjection
			if store.projection != nil {
				copy := *store.projection
				expected = &copy
				require.NoError(t, copy.Validate(before.OrganizationID, before.AgentID))
			}
			view, err := NewAgentQueryService(store).GetAgentForOrganization(context.Background(), before.OrganizationID, before.AgentID)
			require.NoError(t, err)
			require.Equal(t, []ports.AgentRecord{before}, store.reads)
			require.Equal(t, expected, view.RuntimeRecovery)
			require.Equal(t, expected, store.projection, "projection validation must not normalize an opaque barrier or insert defaults")
			require.Equal(t, before, store.record)
		})
	}
	legacy := recoveryProjectionQueryFixture(t).agentQueryStoreStub
	view, err := NewAgentQueryService(legacy).GetAgentForOrganization(context.Background(), legacy.record.OrganizationID, legacy.record.AgentID)
	require.NoError(t, err, "old stores without the optional projection capability remain supported")
	require.Nil(t, view.RuntimeRecovery)
}

func TestRuntimeBarrierRecoveryProjectionQueryChecksScopeBeforeReadingRecovery(t *testing.T) {
	for _, scenario := range []string{"foreign organization", "invalid organization", "missing Agent"} {
		t.Run(scenario, func(t *testing.T) {
			store := recoveryProjectionQueryFixture(t)
			org := store.record.OrganizationID
			want := ErrAgentNotFound
			switch scenario {
			case "foreign organization":
				org = "foreign-org"
			case "invalid organization":
				org, want = "invalid organization", ErrInvalidInput
			case "missing Agent":
				store.agentQueryStoreStub.err = ports.ErrNotFound
			}
			view, err := NewAgentQueryService(store).GetAgentForOrganization(context.Background(), org, store.record.AgentID)
			require.ErrorIs(t, err, want)
			require.Nil(t, view.RuntimeRecovery)
			require.Empty(t, store.reads)
		})
	}
}

func TestRuntimeBarrierRecoveryProjectionQueryRejectsErrorsAndCorruptProjection(t *testing.T) {
	for _, scenario := range []string{"store error", "cancelled read", "wrong Runtime", "wrong reason", "wrong mode",
		"negative policy revision", "unsafe policy revision", "short cooldown", "unstable Rebuild ID", "unstable notification ID", "invalid barrier"} {
		t.Run(scenario, func(t *testing.T) {
			store := recoveryProjectionQueryFixture(t)
			cause := errors.New("original recovery projection read failure")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			want := ErrQueryContract
			switch scenario {
			case "store error":
				store.err, want = cause, cause
			case "cancelled read":
				store.afterRead, want = cancel, context.Canceled
			case "wrong Runtime":
				store.projection.RuntimeRevision = "another-runtime"
			case "wrong reason":
				store.projection.Reason = "agent_unavailable"
			case "wrong mode":
				store.projection.Mode = "automatic"
			case "negative policy revision":
				store.projection.PolicyRevision = -1
			case "unsafe policy revision":
				store.projection.PolicyRevision = domain.RuntimeBarrierRecoveryMaxRevision + 1
			case "short cooldown":
				store.projection.CooldownMS = 59999
			case "unstable Rebuild ID":
				store.projection.RebuildRequestID = "another-valid-request"
			case "unstable notification ID":
				store.projection.NotificationID = "another-valid-notification"
			case "invalid barrier":
				store.projection.BarrierID = "invalid barrier"
			}
			view, err := NewAgentQueryService(store).GetAgentForOrganization(ctx, store.record.OrganizationID, store.record.AgentID)
			require.ErrorIs(t, err, want)
			require.Nil(t, view.RuntimeRecovery, "an errored or invalid recovery cannot leak as a successful Agent projection")
			require.Equal(t, []ports.AgentRecord{store.record}, store.reads)
		})
	}
}

func recoveryNotificationEvent(t *testing.T, sequence int64) ports.AgentEventRecord {
	t.Helper()
	barrier := "notification\x00原/e\u0301-🧪"
	id, err := ports.RuntimeBarrierNotificationID("org-1", "agent-1", barrier)
	require.NoError(t, err)
	event := testAgentEvent(sequence, id, "agent-1", sequence)
	event.EventType = ports.EventAgentRuntimeBarrierRequired
	event.Data = map[string]any{"organization_id": "org-1", "barrier_id": barrier,
		"runtime_revision": "runtime-1", "reason": ports.ExecutionRuntimeBarrierRequired, "policy_revision": float64(0)}
	return event
}

func TestRuntimeBarrierRecoveryNotificationAcceptsExactV1DataAndOpaqueIdentity(t *testing.T) {
	for _, revision := range []float64{0, 1, 9007199254740991} {
		event := recoveryNotificationEvent(t, 1)
		event.Data["policy_revision"] = revision
		store := &agentEventStoreStub{events: []ports.AgentEventRecord{event}}
		page, err := NewEventService(store, store, &agentQueryStoreStub{}).ListGlobalEvents(context.Background(), ListEventsInput{OrganizationID: "org-1"})
		require.NoError(t, err)
		require.Len(t, page.Events, 1)
		assertReadinessReaderEvent(t, page.Events[0], event)
		require.Len(t, page.Events[0].Data, 5)
		require.Equal(t, "notification\x00原/e\u0301-🧪", page.Events[0].Data["barrier_id"])
	}
}

func TestRuntimeBarrierRecoveryNotificationRejectsMalformedDataAndOtherSchemaVersions(t *testing.T) {
	scenarios := []struct {
		name string
		edit func(*ports.AgentEventRecord)
	}{
		{"v2", func(event *ports.AgentEventRecord) { event.SchemaVersion = 2 }},
		{"v3", func(event *ports.AgentEventRecord) { event.SchemaVersion = 3 }},
		{"null data", func(event *ports.AgentEventRecord) { event.Data = nil }},
		{"wrong reason", func(event *ports.AgentEventRecord) { event.Data["reason"] = "agent_unavailable" }},
		{"invalid organization", func(event *ports.AgentEventRecord) { event.Data["organization_id"] = "invalid organization" }},
		{"foreign organization with matching identity", func(event *ports.AgentEventRecord) {
			event.Data["organization_id"] = "foreign-org"
			id, err := ports.RuntimeBarrierNotificationID("foreign-org", event.AgentID, event.Data["barrier_id"].(string))
			require.NoError(t, err)
			event.EventID = id
		}},
		{"invalid Runtime", func(event *ports.AgentEventRecord) { event.Data["runtime_revision"] = "invalid Runtime" }},
		{"whitespace barrier", func(event *ports.AgentEventRecord) { event.Data["barrier_id"] = "invalid barrier" }},
		{"overlong barrier", func(event *ports.AgentEventRecord) { event.Data["barrier_id"] = strings.Repeat("🧪", 201) }},
	}
	for _, field := range []string{"organization_id", "barrier_id", "runtime_revision", "reason", "policy_revision"} {
		scenarios = append(scenarios, struct {
			name string
			edit func(*ports.AgentEventRecord)
		}{"missing " + field, func(event *ports.AgentEventRecord) { delete(event.Data, field) }})
	}
	for _, field := range []string{"unknown", "runtime_execution_id", "mcp_endpoint", "credential", "run", "tool"} {
		scenarios = append(scenarios, struct {
			name string
			edit func(*ports.AgentEventRecord)
		}{"extra " + field, func(event *ports.AgentEventRecord) { event.Data[field] = "synthetic-private-field" }})
	}
	for _, value := range []any{float64(-1), 0.5, float64(9007199254740992), "0", nil} {
		scenarios = append(scenarios, struct {
			name string
			edit func(*ports.AgentEventRecord)
		}{"invalid policy revision", func(event *ports.AgentEventRecord) { event.Data["policy_revision"] = value }})
	}
	for _, scenario := range scenarios {
		t.Run(scenario.name, func(t *testing.T) {
			event := recoveryNotificationEvent(t, 2)
			scenario.edit(&event)
			store := &agentEventStoreStub{events: []ports.AgentEventRecord{testAgentEvent(1, "legacy-event", "agent-1", 1), event}}
			service := NewEventService(store, store, &agentQueryStoreStub{})
			page, err := service.ListGlobalEvents(context.Background(), ListEventsInput{OrganizationID: "org-1"})
			require.ErrorIs(t, err, ErrQueryContract)
			require.Empty(t, page.Events, "a valid prefix cannot hide a corrupt notification")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			emitted := 0
			err = service.WatchGlobalEvents(ctx, "org-1", 0, func(AgentEventView) error { emitted++; cancel(); return nil })
			require.ErrorIs(t, err, ErrQueryContract)
			require.Zero(t, emitted)
		})
	}
}

func TestRuntimeBarrierRecoveryNotificationPreservesHistoricalV1AndReadinessV2Readers(t *testing.T) {
	var records []ports.AgentEventRecord
	for index, kind := range legacyReadinessReaderEventTypes() {
		event := testAgentEvent(int64(index+1), "legacy-"+kind, "agent-1", int64(index+1))
		event.EventType = kind
		event.Data = map[string]any{"legacy_detail": map[string]any{"unrestricted": true}}
		records = append(records, event)
	}
	require.Len(t, records, 20)
	records = append(records, readinessReaderEvent(t, 21, ports.EventRuntimeBound),
		readinessReaderEvent(t, 22, ports.EventAgentReady), recoveryNotificationEvent(t, 23))
	store := &agentEventStoreStub{events: records}
	service := NewEventService(store, store, &agentQueryStoreStub{})
	page, err := service.ListGlobalEvents(context.Background(), ListEventsInput{OrganizationID: "org-1"})
	require.NoError(t, err)
	require.Len(t, page.Events, 23)
	require.EqualValues(t, 23, page.NextSequence)
	for index, event := range page.Events {
		assertReadinessReaderEvent(t, event, records[index])
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var observed []AgentEventView
	err = service.WatchGlobalEvents(ctx, "org-1", 0, func(event AgentEventView) error {
		observed = append(observed, event)
		if event.GlobalSequence == 23 {
			cancel()
		}
		return nil
	})
	require.ErrorIs(t, err, context.Canceled)
	require.Equal(t, page.Events, observed, "List and Watch must expose the same reconstructed five-field notification")
}
