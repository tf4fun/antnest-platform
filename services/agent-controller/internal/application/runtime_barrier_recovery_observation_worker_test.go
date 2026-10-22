package application

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestRuntimeBarrierRecoveryObservationConstructor(t *testing.T) {
	f := newBarrierObservationFixture(1)
	valid := barrierObservationSchedule(1)
	worker, err := NewRuntimeBarrierRecoveryObservationWorker(nil, f.reader, f.admitter, valid, nil)
	require.Error(t, err)
	require.Nil(t, worker)
	worker, err = NewRuntimeBarrierRecoveryObservationWorker(f.store, nil, f.admitter, valid, nil)
	require.Error(t, err)
	require.Nil(t, worker)
	worker, err = NewRuntimeBarrierRecoveryObservationWorker(f.store, f.reader, nil, valid, nil)
	require.Error(t, err)
	require.Nil(t, worker)
	for _, scenario := range []struct {
		name     string
		schedule RuntimeBarrierRecoveryObservationSchedule
	}{
		{"zero poll", RuntimeBarrierRecoveryObservationSchedule{RoundTimeout: time.Second, BatchSize: 1}},
		{"negative poll", RuntimeBarrierRecoveryObservationSchedule{PollInterval: -time.Second, RoundTimeout: time.Second, BatchSize: 1}},
		{"zero round", RuntimeBarrierRecoveryObservationSchedule{PollInterval: time.Second, BatchSize: 1}},
		{"negative round", RuntimeBarrierRecoveryObservationSchedule{PollInterval: time.Second, RoundTimeout: -time.Second, BatchSize: 1}},
		{"zero batch", RuntimeBarrierRecoveryObservationSchedule{PollInterval: time.Second, RoundTimeout: time.Second}},
		{"negative batch", RuntimeBarrierRecoveryObservationSchedule{PollInterval: time.Second, RoundTimeout: time.Second, BatchSize: -1}},
		{"oversized batch", RuntimeBarrierRecoveryObservationSchedule{PollInterval: time.Second, RoundTimeout: time.Second, BatchSize: 1001}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			worker, err := NewRuntimeBarrierRecoveryObservationWorker(f.store, f.reader, f.admitter, scenario.schedule, nil)
			require.Error(t, err)
			require.Nil(t, worker)
		})
	}
	for _, batch := range []int{1, 1000} {
		worker, err := NewRuntimeBarrierRecoveryObservationWorker(f.store, f.reader, f.admitter, barrierObservationSchedule(batch), nil)
		require.NoError(t, err)
		require.NotNil(t, worker)
	}
	require.Empty(t, f.calls.snapshot().events, "construction must not read or dispatch")
}

func TestRuntimeBarrierRecoveryObservationAvailableCandidatesAndOriginalIntent(t *testing.T) {
	f := newBarrierObservationFixture(2)
	// A list projection can lag the authoritative lifecycle base. Its owner,
	// authorization sequences and Runtime revision cannot become admission input.
	f.agents[0].OwnerUserID = "stale-owner"
	f.agents[0].OwnerAuthorizationSequence = 1
	f.agents[0].IdentityRevocationSequence = 0
	f.agents[0].RuntimeRevision = "stale-runtime"
	originalAgents := slices.Clone(f.agents)
	worker := newBarrierObservationWorker(t, f, barrierObservationSchedule(3))
	before := time.Now()
	require.NoError(t, worker.RunOnce(context.Background()))
	s := f.calls.snapshot()
	require.Equal(t, []ports.AgentQuery{{LifecycleState: domain.AgentCreated,
		ActivationState: domain.ActivationEnabled, Limit: 3}}, s.listed,
		"scan all organizations, without a Runtime-state, owner or deleted filter")
	require.Len(t, s.queries, 2, "available Agents can already have a durable ACP barrier")
	require.Len(t, s.intents, 2)
	var expectedEvents []string
	expectedEvents = append(expectedEvents, "list:")
	for index, agent := range f.agents {
		base := f.bases[agent.AgentID]
		query := ports.RuntimeBarrierQuery{OrganizationID: base.Agent.OrganizationID,
			AgentID: base.Agent.AgentID, ExpectedRuntimeRevision: base.Agent.RuntimeRevision}
		require.Equal(t, domain.RuntimeAvailable, agent.RuntimeState)
		require.Equal(t, query, s.queries[index])
		fact := barrierObservationFact(query)
		requestID, err := ports.RuntimeBarrierRecoveryRequestID(query.OrganizationID, query.AgentID, fact.Barrier.BarrierID)
		require.NoError(t, err)
		require.NotEqual(t, base.SourceExecution.RuntimeExecutionID, fact.Barrier.RuntimeExecutionID,
			"the retained barrier execution is intentionally different from current health")
		require.Equal(t, ports.RuntimeBarrierRecoveryIntent{
			Fact: fact, ExpectedPolicyRevision: 9, ExpectedOwnerUserID: base.Agent.OwnerUserID,
			ExpectedOwnerAuthorizationSequence: base.Agent.OwnerAuthorizationSequence,
			ExpectedIdentityRevocationSequence: base.Agent.IdentityRevocationSequence,
			Command: ports.RuntimeBarrierRebuildCommand{RequestID: requestID,
				OrganizationID: query.OrganizationID, AgentID: query.AgentID, ActorPrincipalID: "agent-controller",
				TemplateID:       base.ConfiguredSpec.Snapshot.TemplateID,
				TemplateRevision: base.ConfiguredSpec.Snapshot.TemplateRevision},
		}, s.intents[index], "only the configured Template snapshot and original opaque fact may be forwarded")
		expectedEvents = append(expectedEvents, "base:"+agent.AgentID, "barrier:"+agent.AgentID,
			"policy:"+agent.OrganizationID, "admit:"+agent.AgentID)
	}
	require.Equal(t, expectedEvents, s.events)
	require.Equal(t, originalAgents, f.agents, "scan input cannot be rewritten")
	var deadline time.Time
	for index, ctx := range s.contexts {
		actual, ok := ctx.Deadline()
		require.True(t, ok, "list/base/ACP/policy/admission all need a bound")
		if index == 0 {
			deadline = actual
		}
		require.Equal(t, deadline, actual, "a later dependency must not get a fresh budget")
	}
	require.False(t, deadline.Before(before))
	require.False(t, deadline.After(time.Now().Add(barrierObservationSchedule(3).RoundTimeout)))

	t.Run("configured source without a healthy execution is still observable", func(t *testing.T) {
		f := newBarrierObservationFixture(1)
		base := f.bases[f.agents[0].AgentID]
		base.Agent.RuntimeState = domain.RuntimeUnknown
		base.Agent.ExecutionRevisionID, base.Agent.LastSuccessfulExecutionRevisionID = "", ""
		base.Agent.RuntimeExecutionID, base.Agent.RuntimeMCPEndpoint = "", ""
		base.SourceExecution = ports.ExecutionRecord{}
		f.bases[base.Agent.AgentID] = base
		require.True(t, base.Agent.CanObserveRuntime())
		require.True(t, (ports.AgentRuntimeSource{Spec: base.ConfiguredSpec, Execution: base.SourceExecution}).MatchesAgent(base.Agent))
		require.NoError(t, newBarrierObservationWorker(t, f, barrierObservationSchedule(2)).RunOnce(context.Background()))
		require.Len(t, f.calls.snapshot().intents, 1)
	})
}

func TestRuntimeBarrierRecoveryObservationWholePageValidationPreservesCursor(t *testing.T) {
	for _, name := range []string{"missing ID", "invalid ID", "oversized ID", "missing organization", "invalid organization",
		"zero creation time", "duplicate tuple", "descending ID", "descending time", "not after cursor", "oversized page", "list error"} {
		t.Run(name, func(t *testing.T) {
			f := newBarrierObservationFixture(5)
			bad := slices.Clone(f.agents[2:4])
			listFailure := errors.New("list returned rows and a private failure")
			var pageError error
			switch name {
			case "missing ID":
				bad[1].AgentID = ""
			case "invalid ID":
				bad[1].AgentID = "~invalid"
			case "oversized ID":
				bad[1].AgentID = strings.Repeat("a", 201)
			case "missing organization":
				bad[1].OrganizationID = ""
			case "invalid organization":
				bad[1].OrganizationID = "org invalid"
			case "zero creation time":
				bad[1].CreatedAt = time.Time{}
			case "duplicate tuple":
				bad[1] = bad[0]
			case "descending ID":
				bad[0], bad[1] = bad[1], bad[0]
			case "descending time":
				bad[1].CreatedAt = bad[0].CreatedAt.Add(-time.Second)
			case "not after cursor":
				bad[1] = f.agents[1]
			case "oversized page":
				bad = append(bad, f.agents[4])
			case "list error":
				pageError = listFailure
			}
			lists := 0
			f.store.list = func(context.Context, ports.AgentQuery) ([]ports.AgentRecord, error) {
				lists++
				switch lists {
				case 1:
					return f.agents[:2], nil
				case 2:
					return bad, pageError
				default:
					return f.agents[2:3], nil
				}
			}
			worker := newBarrierObservationWorker(t, f, barrierObservationSchedule(2))
			require.NoError(t, worker.RunOnce(context.Background()))
			before := f.calls.snapshot()
			err := worker.RunOnce(context.Background())
			if pageError != nil {
				require.ErrorIs(t, err, listFailure)
			} else {
				require.ErrorIs(t, err, ErrQueryContract)
			}
			after := f.calls.snapshot()
			require.Equal(t, before.bases, after.bases, "no valid prefix of an invalid page may be observed")
			require.Equal(t, before.queries, after.queries)
			require.Equal(t, before.policies, after.policies)
			require.Equal(t, before.intents, after.intents)
			require.NoError(t, worker.RunOnce(context.Background()))
			last := f.calls.snapshot()
			require.Len(t, last.listed, 3)
			require.Equal(t, last.listed[1], last.listed[2], "a rejected page must not advance the scan cursor")
			require.Equal(t, f.agents[1].CreatedAt, last.listed[2].AfterCreatedAt)
			require.Equal(t, f.agents[1].AgentID, last.listed[2].AfterAgentID)
			require.Len(t, last.intents, 3)
		})
	}
}

func TestRuntimeBarrierRecoveryObservationBaseScopeAndApplicability(t *testing.T) {
	for _, name := range []string{"foreign Agent", "foreign organization", "base error", "disabled desired state", "deleted",
		"disabled activation", "owner revoked", "active operation", "missing owner", "invalid owner", "missing runtime revision",
		"missing spec", "partial execution binding", "different spec", "foreign spec Agent", "different execution",
		"foreign execution Agent", "different execution spec", "old execution runtime"} {
		t.Run(name, func(t *testing.T) {
			f := newBarrierObservationFixture(1)
			id := f.agents[0].AgentID
			base := f.bases[id]
			failure := errors.New("private lifecycle base failure")
			switch name {
			case "foreign Agent":
				base.Agent.AgentID = "agent-foreign"
			case "foreign organization":
				base.Agent.OrganizationID = "org-foreign"
			case "base error":
				f.store.base = func(context.Context, string) (ports.AgentLifecycleBase, error) { return base, failure }
			case "disabled desired state":
				base.Agent.DesiredState = domain.DesiredDisabled
			case "deleted":
				base.Agent.LifecycleState = domain.AgentDeleted
			case "disabled activation":
				base.Agent.ActivationState = domain.ActivationDisabled
			case "owner revoked":
				base.Agent.IdentityRevocationSequence = base.Agent.OwnerAuthorizationSequence + 1
			case "active operation":
				base.Agent.ActiveOperationRequestID = "request-running"
			case "missing owner":
				base.Agent.OwnerUserID = ""
			case "invalid owner":
				base.Agent.OwnerUserID = "owner invalid"
			case "missing runtime revision":
				base.Agent.RuntimeRevision = ""
			case "missing spec":
				base.Agent.AgentSpecRevisionID = ""
			case "partial execution binding":
				base.Agent.RuntimeMCPEndpoint = ""
			case "different spec":
				base.ConfiguredSpec.ID = "spec-other"
			case "foreign spec Agent":
				base.ConfiguredSpec.AgentID = "agent-foreign"
			case "different execution":
				base.SourceExecution.ID = "execution-other"
			case "foreign execution Agent":
				base.SourceExecution.AgentID = "agent-foreign"
			case "different execution spec":
				base.SourceExecution.AgentSpecRevisionID = "spec-other"
			case "old execution runtime":
				base.SourceExecution.RuntimeRevision = "runtime-old"
			}
			f.bases[id] = base
			err := newBarrierObservationWorker(t, f, barrierObservationSchedule(2)).RunOnce(context.Background())
			switch name {
			case "foreign Agent", "foreign organization", "invalid owner", "different spec", "foreign spec Agent",
				"different execution", "foreign execution Agent", "different execution spec", "old execution runtime":
				require.ErrorIs(t, err, ErrQueryContract)
			case "base error":
				require.ErrorIs(t, err, failure)
			default:
				require.NoError(t, err, "inapplicable current lifecycle state is skipped")
			}
			s := f.calls.snapshot()
			require.Equal(t, []string{id}, s.bases)
			require.Empty(t, s.queries)
			require.Empty(t, s.policies)
			require.Empty(t, s.intents)
		})
	}
}

func TestRuntimeBarrierRecoveryObservationFactAndPolicyFailClosed(t *testing.T) {
	for _, name := range []string{"no barrier", "foreign organization", "foreign Agent", "old revision", "missing barrier ID",
		"missing execution ID", "wrong reason", "invalid opaque ID", "oversized opaque ID", "ACP error"} {
		t.Run(name, func(t *testing.T) {
			f := newBarrierObservationFixture(1)
			failure := errors.New("private ACP read failed")
			f.reader.read = func(_ context.Context, query ports.RuntimeBarrierQuery) (ports.RuntimeBarrierResult, error) {
				fact := barrierObservationFact(query)
				switch name {
				case "no barrier":
					fact.Barrier = nil
				case "foreign organization":
					fact.OrganizationID = "org-foreign"
				case "foreign Agent":
					fact.AgentID = "agent-foreign"
				case "old revision":
					fact.RuntimeRevision = "runtime-old"
				case "missing barrier ID":
					fact.Barrier.BarrierID = ""
				case "missing execution ID":
					fact.Barrier.RuntimeExecutionID = ""
				case "wrong reason":
					fact.Barrier.Reason = "healthy"
				case "invalid opaque ID":
					fact.Barrier.BarrierID = "has space"
				case "oversized opaque ID":
					fact.Barrier.RuntimeExecutionID = strings.Repeat("🧪", 201)
				case "ACP error":
					return fact, failure
				}
				return fact, nil
			}
			err := newBarrierObservationWorker(t, f, barrierObservationSchedule(2)).RunOnce(context.Background())
			if name == "no barrier" {
				require.NoError(t, err)
			} else if name == "ACP error" {
				require.ErrorIs(t, err, failure)
			} else {
				require.ErrorIs(t, err, ErrQueryContract)
			}
			s := f.calls.snapshot()
			require.Len(t, s.queries, 1)
			require.Empty(t, s.policies, "a missing, invalid or failed fact cannot select policy")
			require.Empty(t, s.intents)
		})
	}
	for _, name := range []string{"notify", "manual", "foreign organization", "unknown mode", "negative revision", "unsafe revision",
		"short cooldown", "long cooldown", "invalid logical default", "policy error"} {
		t.Run("policy/"+name, func(t *testing.T) {
			f := newBarrierObservationFixture(1)
			failure := errors.New("private policy read failed")
			f.store.policy = func(_ context.Context, org string) (domain.RuntimeBarrierRecoveryPolicy, error) {
				policy := barrierObservationPolicy(org)
				switch name {
				case "notify", "manual":
					policy.Mode = name
				case "foreign organization":
					policy.OrganizationID = "org-foreign"
				case "unknown mode":
					policy.Mode = "fallback"
				case "negative revision":
					policy.Revision = -1
				case "unsafe revision":
					policy.Revision = domain.RuntimeBarrierRecoveryMaxRevision + 1
				case "short cooldown":
					policy.CooldownMS = 59999
				case "long cooldown":
					policy.CooldownMS = 86400001
				case "invalid logical default":
					policy.Revision = 0
				case "policy error":
					return policy, failure
				}
				return policy, nil
			}
			err := newBarrierObservationWorker(t, f, barrierObservationSchedule(2)).RunOnce(context.Background())
			switch name {
			case "notify", "manual":
				require.NoError(t, err)
			case "policy error":
				require.ErrorIs(t, err, failure)
			default:
				require.ErrorIs(t, err, ErrQueryContract)
			}
			s := f.calls.snapshot()
			require.Len(t, s.queries, 1)
			require.Equal(t, []string{f.agents[0].OrganizationID}, s.policies)
			require.Empty(t, s.intents, "policy errors must never fall back to automatic admission")
		})
	}
}

func TestRuntimeBarrierRecoveryObservationFairnessAndWrapping(t *testing.T) {
	for _, stage := range []string{"base", "barrier", "policy", "admit"} {
		t.Run("failed head/"+stage, func(t *testing.T) {
			f := newBarrierObservationFixture(2)
			failure := errors.New("first observation remains unavailable")
			first := f.agents[0]
			switch stage {
			case "base":
				f.store.base = func(_ context.Context, id string) (ports.AgentLifecycleBase, error) {
					if id == first.AgentID {
						return ports.AgentLifecycleBase{}, failure
					}
					return f.bases[id], nil
				}
			case "barrier":
				f.reader.read = func(_ context.Context, q ports.RuntimeBarrierQuery) (ports.RuntimeBarrierResult, error) {
					if q.AgentID == first.AgentID {
						return ports.RuntimeBarrierResult{}, failure
					}
					return barrierObservationFact(q), nil
				}
			case "policy":
				f.store.policy = func(_ context.Context, org string) (domain.RuntimeBarrierRecoveryPolicy, error) {
					if org == first.OrganizationID {
						return domain.RuntimeBarrierRecoveryPolicy{}, failure
					}
					return barrierObservationPolicy(org), nil
				}
			case "admit":
				f.admitter.admit = func(_ context.Context, intent ports.RuntimeBarrierRecoveryIntent) (RuntimeBarrierRecoveryAdmissionResult, error) {
					if intent.Fact.AgentID == first.AgentID {
						return RuntimeBarrierRecoveryAdmissionResult{}, failure
					}
					return RuntimeBarrierRecoveryAdmissionResult{}, nil
				}
			}
			worker := newBarrierObservationWorker(t, f, barrierObservationSchedule(2))
			require.ErrorIs(t, worker.RunOnce(context.Background()), failure)
			s := f.calls.snapshot()
			require.Equal(t, f.agents[1].AgentID, s.intents[len(s.intents)-1].Fact.AgentID,
				"an error for the first Agent cannot prevent the next Agent's admission")
			require.NoError(t, worker.RunOnce(context.Background()), "the following empty page wraps without new work")
			require.Equal(t, f.agents[1].CreatedAt, f.calls.snapshot().listed[1].AfterCreatedAt)
			require.Equal(t, f.agents[1].AgentID, f.calls.snapshot().listed[1].AfterAgentID)
			require.ErrorIs(t, worker.RunOnce(context.Background()), failure)
			require.True(t, f.calls.snapshot().listed[2].AfterCreatedAt.IsZero())
			require.Empty(t, f.calls.snapshot().listed[2].AfterAgentID)
		})
	}
	t.Run("full page advances and complete short page wraps", func(t *testing.T) {
		f := newBarrierObservationFixture(5)
		worker := newBarrierObservationWorker(t, f, barrierObservationSchedule(2))
		for round := 0; round < 4; round++ {
			require.NoError(t, worker.RunOnce(context.Background()))
		}
		s := f.calls.snapshot()
		require.Len(t, s.listed, 4, "each round consumes one bounded page")
		require.Equal(t, f.agents[1].AgentID, s.listed[1].AfterAgentID)
		require.Equal(t, f.agents[3].AgentID, s.listed[2].AfterAgentID)
		require.True(t, s.listed[3].AfterCreatedAt.IsZero())
		require.Empty(t, s.listed[3].AfterAgentID)
		var ids []string
		for _, intent := range s.intents {
			ids = append(ids, intent.Fact.AgentID)
		}
		require.Equal(t, []string{f.agents[0].AgentID, f.agents[1].AgentID, f.agents[2].AgentID,
			f.agents[3].AgentID, f.agents[4].AgentID, f.agents[0].AgentID, f.agents[1].AgentID}, ids)
	})
}

func TestRuntimeBarrierRecoveryObservationCancellationJoinsActualDependencies(t *testing.T) {
	for _, stage := range []string{"list", "base", "barrier", "policy", "admit"} {
		for _, deadline := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/deadline=%t", stage, deadline), func(t *testing.T) {
				synctest.Test(t, func(t *testing.T) {
					f := newBarrierObservationFixture(2)
					hold := newBarrierObservationHold()
					switch stage {
					case "list":
						f.store.list = func(ctx context.Context, _ ports.AgentQuery) ([]ports.AgentRecord, error) {
							hold.wait(ctx)
							return f.agents, nil
						}
					case "base":
						f.store.base = func(ctx context.Context, id string) (ports.AgentLifecycleBase, error) {
							hold.wait(ctx)
							return f.bases[id], nil
						}
					case "barrier":
						f.reader.read = func(ctx context.Context, q ports.RuntimeBarrierQuery) (ports.RuntimeBarrierResult, error) {
							hold.wait(ctx)
							return barrierObservationFact(q), nil
						}
					case "policy":
						f.store.policy = func(ctx context.Context, org string) (domain.RuntimeBarrierRecoveryPolicy, error) {
							hold.wait(ctx)
							return barrierObservationPolicy(org), nil
						}
					case "admit":
						f.admitter.admit = func(ctx context.Context, _ ports.RuntimeBarrierRecoveryIntent) (RuntimeBarrierRecoveryAdmissionResult, error) {
							hold.wait(ctx)
							return RuntimeBarrierRecoveryAdmissionResult{}, nil
						}
					}
					schedule := barrierObservationSchedule(2)
					worker := newBarrierObservationWorker(t, f, schedule)
					ctx, cancel := context.WithCancel(context.Background())
					task := startBarrierObservationTask(func() error { return worker.RunOnce(ctx) })
					defer func() { defer func() { _ = task.join(t) }(); cancel(); hold.release(); hold.joinIfStarted(t) }()
					waitBarrierObservationHeld(t, hold, task)
					if deadline {
						awaitBarrierObservation(t, hold.cancelled, schedule.RoundTimeout+time.Second, "the round deadline never reached the real callback")
					} else {
						cancel()
						synctest.Wait()
						requireBarrierObservationClosed(t, hold.cancelled, "the real callback did not receive parent cancellation")
					}
					synctest.Wait()
					select {
					case <-task.done:
						t.Fatal("RunOnce returned before the actual held callback settled")
					default:
					}
					hold.release()
					hold.joinIfStarted(t)
					err := task.join(t)
					if deadline {
						require.ErrorIs(t, err, context.DeadlineExceeded)
					} else {
						require.ErrorIs(t, err, context.Canceled)
					}
					s := f.calls.snapshot()
					require.Len(t, s.listed, 1)
					if stage == "list" {
						require.Empty(t, s.bases)
					} else {
						require.Equal(t, []string{f.agents[0].AgentID}, s.bases)
					}
					if stage == "admit" {
						require.Len(t, s.intents, 1)
					} else {
						require.Empty(t, s.intents, "late successful observation cannot become a new admission")
					}
					if stage == "barrier" {
						f.reader.read = nil
						require.NoError(t, worker.RunOnce(context.Background()))
						last := f.calls.snapshot()
						require.Equal(t, f.agents[0].AgentID, last.listed[1].AfterAgentID,
							"cancellation may not skip the unvisited tail of the original page")
						require.Equal(t, f.agents[0].CreatedAt, last.listed[1].AfterCreatedAt)
						require.Len(t, last.intents, 1)
						require.Equal(t, f.agents[1].AgentID, last.intents[0].Fact.AgentID)
					}
				})
			})
		}
	}
}

func TestRuntimeBarrierRecoveryObservationRunAndGateCancellation(t *testing.T) {
	t.Run("pre-cancellation touches no dependencies", func(t *testing.T) {
		f := newBarrierObservationFixture(1)
		worker := newBarrierObservationWorker(t, f, barrierObservationSchedule(1))
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		require.ErrorIs(t, worker.RunOnce(ctx), context.Canceled)
		worker.Run(ctx)
		require.Empty(t, f.calls.snapshot().events)
	})
	t.Run("Run begins immediately and joins its actual observation", func(t *testing.T) {
		synctest.Test(t, func(t *testing.T) {
			f := newBarrierObservationFixture(1)
			hold := newBarrierObservationHold()
			f.reader.read = func(ctx context.Context, q ports.RuntimeBarrierQuery) (ports.RuntimeBarrierResult, error) {
				hold.wait(ctx)
				return barrierObservationFact(q), nil
			}
			worker := newBarrierObservationWorker(t, f, barrierObservationSchedule(1))
			ctx, cancel := context.WithCancel(context.Background())
			task := startBarrierObservationTask(func() error { worker.Run(ctx); return nil })
			defer func() { defer func() { _ = task.join(t) }(); cancel(); hold.release(); hold.joinIfStarted(t) }()
			synctest.Wait()
			requireBarrierObservationClosed(t, hold.started, "Run must observe before its first poll interval")
			cancel()
			synctest.Wait()
			requireBarrierObservationClosed(t, hold.cancelled, "Run cancellation did not reach the real read")
			select {
			case <-task.done:
				t.Fatal("Run detached its actual observation")
			default:
			}
			hold.release()
			hold.joinIfStarted(t)
			require.NoError(t, task.join(t))
			require.Len(t, f.calls.snapshot().listed, 1)
			require.Empty(t, f.calls.snapshot().intents)
		})
	})
	t.Run("concurrent RunOnce waits cancellably without touching dependencies", func(t *testing.T) {
		synctest.Test(t, func(t *testing.T) {
			f := newBarrierObservationFixture(1)
			hold := newBarrierObservationHold()
			f.reader.read = func(ctx context.Context, q ports.RuntimeBarrierQuery) (ports.RuntimeBarrierResult, error) {
				hold.wait(ctx)
				return barrierObservationFact(q), nil
			}
			worker := newBarrierObservationWorker(t, f, barrierObservationSchedule(1))
			firstCtx, cancelFirst := context.WithCancel(context.Background())
			secondCtx, cancelSecond := context.WithCancel(context.Background())
			first := startBarrierObservationTask(func() error { return worker.RunOnce(firstCtx) })
			var second *barrierObservationTask
			defer func() {
				defer func() { _ = first.join(t) }()
				if second != nil {
					defer func() { _ = second.join(t) }()
				}
				cancelFirst()
				cancelSecond()
				hold.release()
				hold.joinIfStarted(t)
			}()
			waitBarrierObservationHeld(t, hold, first)
			before := f.calls.snapshot()
			second = startBarrierObservationTask(func() error { return worker.RunOnce(secondCtx) })
			synctest.Wait()
			require.Equal(t, before.events, f.calls.snapshot().events)
			cancelSecond()
			require.ErrorIs(t, second.join(t), context.Canceled)
			require.Equal(t, before.events, f.calls.snapshot().events, "a cancelled gate waiter cannot start another page")
			cancelFirst()
			hold.release()
			hold.joinIfStarted(t)
			require.ErrorIs(t, first.join(t), context.Canceled)
			require.Empty(t, f.calls.snapshot().intents)
		})
	})
}

func TestRuntimeBarrierRecoveryObservationLogsExcludePrivateCausesAndIdentity(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newBarrierObservationFixture(1)
		canaries := []string{"raw-database-secret", f.agents[0].AgentID, f.agents[0].OrganizationID,
			f.agents[0].OwnerUserID, "opaque-barrier-🧪", "execution-private", "http://runtime-private:8080/mcp"}
		f.store.list = func(context.Context, ports.AgentQuery) ([]ports.AgentRecord, error) {
			return nil, errors.New(strings.Join(canaries, ":"))
		}
		var output bytes.Buffer
		worker, err := NewRuntimeBarrierRecoveryObservationWorker(f.store, f.reader, f.admitter,
			barrierObservationSchedule(1), slog.New(slog.NewJSONHandler(&output, nil)))
		require.NoError(t, err)
		ctx, cancel := context.WithCancel(context.Background())
		task := startBarrierObservationTask(func() error { worker.Run(ctx); return nil })
		defer func() { cancel(); _ = task.join(t) }()
		synctest.Wait()
		cancel()
		require.NoError(t, task.join(t))
		require.NotEmpty(t, output.String(), "failed rounds still need a safe diagnostic")
		for _, secret := range canaries {
			require.NotContains(t, output.String(), secret)
		}
		require.Empty(t, f.calls.snapshot().intents)
	})
}

type barrierObservationRunner interface {
	Run(context.Context)
	RunOnce(context.Context) error
}

func barrierObservationSchedule(batch int) RuntimeBarrierRecoveryObservationSchedule {
	return RuntimeBarrierRecoveryObservationSchedule{PollInterval: time.Minute, RoundTimeout: 5 * time.Second, BatchSize: batch}
}

func newBarrierObservationWorker(t *testing.T, f *barrierObservationFixture, schedule RuntimeBarrierRecoveryObservationSchedule) barrierObservationRunner {
	t.Helper()
	worker, err := NewRuntimeBarrierRecoveryObservationWorker(f.store, f.reader, f.admitter, schedule,
		slog.New(slog.NewTextHandler(io.Discard, nil)))
	require.NoError(t, err)
	require.NotNil(t, worker)
	return worker
}

type barrierObservationFixture struct {
	agents   []ports.AgentRecord
	bases    map[string]ports.AgentLifecycleBase
	calls    *barrierObservationCalls
	store    *barrierObservationStore
	reader   *barrierObservationReader
	admitter *barrierObservationAdmitter
}

func newBarrierObservationFixture(count int) *barrierObservationFixture {
	f := &barrierObservationFixture{bases: make(map[string]ports.AgentLifecycleBase), calls: &barrierObservationCalls{}}
	createdAt := time.Date(2026, 10, 22, 20, 0, 0, 123456000, time.UTC)
	for index := 0; index < count; index++ {
		id := fmt.Sprintf("agent-observation-%03d", index)
		agent := ports.AgentRecord{AgentID: id, OrganizationID: fmt.Sprintf("org-observation-%d", index%2),
			OwnerUserID: fmt.Sprintf("owner-observation-%03d", index), DesiredState: domain.DesiredEnabled,
			LifecycleState: domain.AgentCreated, ActivationState: domain.ActivationEnabled, RuntimeState: domain.RuntimeAvailable,
			CreatedAt: createdAt.Add(time.Duration(index/2) * time.Second), AgentSpecRevisionID: "spec-" + id,
			ExecutionRevisionID: "execution-" + id, LastSuccessfulExecutionRevisionID: "execution-" + id,
			RuntimeRevision: "runtime-" + id, RuntimeExecutionID: "current-health-" + id,
			RuntimeMCPEndpoint: "http://runtime-private:8080/mcp", OwnerAuthorizationSequence: int64(20 + index),
			IdentityRevocationSequence: int64(10 + index)}
		f.agents = append(f.agents, agent)
		f.bases[id] = ports.AgentLifecycleBase{Agent: agent,
			ConfiguredSpec: ports.AgentSpecRecord{ID: agent.AgentSpecRevisionID, AgentID: id, Revision: 3,
				Snapshot: domain.AgentSpecSnapshot{TemplateID: "template-configured-" + id, TemplateRevision: int64(7 + index)}},
			SourceExecution: ports.ExecutionRecord{ID: agent.ExecutionRevisionID, AgentID: id,
				AgentSpecRevisionID: agent.AgentSpecRevisionID, RuntimeRevision: agent.RuntimeRevision,
				RuntimeExecutionID: agent.RuntimeExecutionID, RuntimeMCPEndpoint: agent.RuntimeMCPEndpoint},
			NextSpecRevision: 4, NextExecutionRevision: 5}
	}
	f.store = &barrierObservationStore{fixture: f}
	f.reader = &barrierObservationReader{calls: f.calls}
	f.admitter = &barrierObservationAdmitter{calls: f.calls}
	return f
}

func barrierObservationFact(query ports.RuntimeBarrierQuery) ports.RuntimeBarrierResult {
	return ports.RuntimeBarrierResult{OrganizationID: query.OrganizationID, AgentID: query.AgentID,
		RuntimeRevision: query.ExpectedRuntimeRevision, Barrier: &ports.RuntimeBarrier{
			BarrierID: "opaque-🧪\x00\u0085-" + query.AgentID, Reason: ports.ExecutionRuntimeBarrierRequired,
			RuntimeExecutionID: "original-🧪\x01\u0085-execution"}}
}

func barrierObservationPolicy(org string) domain.RuntimeBarrierRecoveryPolicy {
	return domain.RuntimeBarrierRecoveryPolicy{OrganizationID: org, Revision: 9, Mode: "auto", CooldownMS: 300000}
}

type barrierObservationSnapshot struct {
	events   []string
	listed   []ports.AgentQuery
	bases    []string
	queries  []ports.RuntimeBarrierQuery
	policies []string
	intents  []ports.RuntimeBarrierRecoveryIntent
	contexts []context.Context
}

type barrierObservationCalls struct {
	mu    sync.Mutex
	state barrierObservationSnapshot
}

func (calls *barrierObservationCalls) record(ctx context.Context, kind, id string, value any) {
	calls.mu.Lock()
	defer calls.mu.Unlock()
	calls.state.events = append(calls.state.events, kind+":"+id)
	calls.state.contexts = append(calls.state.contexts, ctx)
	switch kind {
	case "list":
		calls.state.listed = append(calls.state.listed, value.(ports.AgentQuery))
	case "base":
		calls.state.bases = append(calls.state.bases, id)
	case "barrier":
		calls.state.queries = append(calls.state.queries, value.(ports.RuntimeBarrierQuery))
	case "policy":
		calls.state.policies = append(calls.state.policies, id)
	case "admit":
		intent := value.(ports.RuntimeBarrierRecoveryIntent)
		if intent.Fact.Barrier != nil {
			barrier := *intent.Fact.Barrier
			intent.Fact.Barrier = &barrier
		}
		calls.state.intents = append(calls.state.intents, intent)
	}
}

func (calls *barrierObservationCalls) snapshot() barrierObservationSnapshot {
	calls.mu.Lock()
	defer calls.mu.Unlock()
	s := calls.state
	s.events, s.listed, s.bases = slices.Clone(s.events), slices.Clone(s.listed), slices.Clone(s.bases)
	s.queries, s.policies, s.contexts = slices.Clone(s.queries), slices.Clone(s.policies), slices.Clone(s.contexts)
	s.intents = slices.Clone(s.intents)
	for index := range s.intents {
		if s.intents[index].Fact.Barrier != nil {
			barrier := *s.intents[index].Fact.Barrier
			s.intents[index].Fact.Barrier = &barrier
		}
	}
	return s
}

type barrierObservationStore struct {
	fixture *barrierObservationFixture
	list    func(context.Context, ports.AgentQuery) ([]ports.AgentRecord, error)
	base    func(context.Context, string) (ports.AgentLifecycleBase, error)
	policy  func(context.Context, string) (domain.RuntimeBarrierRecoveryPolicy, error)
}

func (store *barrierObservationStore) ListAgents(ctx context.Context, query ports.AgentQuery) ([]ports.AgentRecord, error) {
	store.fixture.calls.record(ctx, "list", "", query)
	if store.list != nil {
		return store.list(ctx, query)
	}
	var result []ports.AgentRecord
	for _, agent := range store.fixture.agents {
		if agent.CreatedAt.Before(query.AfterCreatedAt) || agent.CreatedAt.Equal(query.AfterCreatedAt) && agent.AgentID <= query.AfterAgentID {
			continue
		}
		result = append(result, agent)
		if len(result) == query.Limit {
			break
		}
	}
	return result, nil
}

func (store *barrierObservationStore) GetAgentLifecycleBase(ctx context.Context, id string) (ports.AgentLifecycleBase, error) {
	store.fixture.calls.record(ctx, "base", id, nil)
	if store.base != nil {
		return store.base(ctx, id)
	}
	base, ok := store.fixture.bases[id]
	if !ok {
		return ports.AgentLifecycleBase{}, errors.New("unexpected lifecycle base read")
	}
	return base, nil
}

func (store *barrierObservationStore) GetRuntimeBarrierRecoveryPolicy(ctx context.Context, org string) (domain.RuntimeBarrierRecoveryPolicy, error) {
	store.fixture.calls.record(ctx, "policy", org, nil)
	if store.policy != nil {
		return store.policy(ctx, org)
	}
	return barrierObservationPolicy(org), nil
}

type barrierObservationReader struct {
	calls *barrierObservationCalls
	read  func(context.Context, ports.RuntimeBarrierQuery) (ports.RuntimeBarrierResult, error)
}

func (reader *barrierObservationReader) GetRuntimeBarrier(ctx context.Context, query ports.RuntimeBarrierQuery) (ports.RuntimeBarrierResult, error) {
	reader.calls.record(ctx, "barrier", query.AgentID, query)
	if reader.read != nil {
		return reader.read(ctx, query)
	}
	return barrierObservationFact(query), nil
}

type barrierObservationAdmitter struct {
	calls *barrierObservationCalls
	admit func(context.Context, ports.RuntimeBarrierRecoveryIntent) (RuntimeBarrierRecoveryAdmissionResult, error)
}

func (admitter *barrierObservationAdmitter) Admit(ctx context.Context, intent ports.RuntimeBarrierRecoveryIntent) (RuntimeBarrierRecoveryAdmissionResult, error) {
	admitter.calls.record(ctx, "admit", intent.Fact.AgentID, intent)
	if admitter.admit != nil {
		return admitter.admit(ctx, intent)
	}
	return RuntimeBarrierRecoveryAdmissionResult{}, nil
}

type barrierObservationHold struct {
	started, cancelled, released, returned         chan struct{}
	startOnce, cancelOnce, releaseOnce, returnOnce sync.Once
}

func newBarrierObservationHold() *barrierObservationHold {
	return &barrierObservationHold{started: make(chan struct{}), cancelled: make(chan struct{}),
		released: make(chan struct{}), returned: make(chan struct{})}
}

func (hold *barrierObservationHold) wait(ctx context.Context) {
	hold.startOnce.Do(func() { close(hold.started) })
	select {
	case <-ctx.Done():
		hold.cancelOnce.Do(func() { close(hold.cancelled) })
		<-hold.released
	case <-hold.released:
	}
	hold.returnOnce.Do(func() { close(hold.returned) })
}

func (hold *barrierObservationHold) release() { hold.releaseOnce.Do(func() { close(hold.released) }) }

func (hold *barrierObservationHold) joinIfStarted(t *testing.T) {
	t.Helper()
	select {
	case <-hold.started:
		awaitBarrierObservation(t, hold.returned, 2*time.Second, "released callback did not actually return")
	default:
	}
}

type barrierObservationTask struct {
	done chan struct{}
	err  error
}

func startBarrierObservationTask(run func() error) *barrierObservationTask {
	task := &barrierObservationTask{done: make(chan struct{})}
	go func() { defer close(task.done); task.err = run() }()
	return task
}

func (task *barrierObservationTask) join(t *testing.T) error {
	t.Helper()
	awaitBarrierObservation(t, task.done, 2*time.Second, "worker did not join after its actual callbacks were released")
	return task.err
}

func awaitBarrierObservation(t *testing.T, done <-chan struct{}, budget time.Duration, message string) {
	t.Helper()
	timer := time.NewTimer(budget)
	defer timer.Stop()
	select {
	case <-done:
	case <-timer.C:
		t.Fatal(message)
	}
}

func requireBarrierObservationClosed(t *testing.T, done <-chan struct{}, message string) {
	t.Helper()
	select {
	case <-done:
	default:
		t.Fatal(message)
	}
}

func waitBarrierObservationHeld(t *testing.T, hold *barrierObservationHold, task *barrierObservationTask) {
	t.Helper()
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	select {
	case <-hold.started:
	case <-task.done:
		t.Fatalf("worker returned before the original dependency started: %v", task.err)
	case <-timer.C:
		t.Fatal("worker did not enter its original dependency")
	}
}
