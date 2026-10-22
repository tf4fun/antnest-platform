package application

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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

func TestRuntimeBarrierRecoveryStartWorkerScheduleAndOriginalProtocol(t *testing.T) {
	t.Run("constructor rejects incomplete dependencies and invalid schedules", func(t *testing.T) {
		calls := &pendingStartWorkerCalls{}
		store := &pendingStartWorkerStoreStub{calls: calls}
		starter := &pendingStartWorkerStarterStub{calls: calls}
		valid := pendingStartWorkerSchedule(2)
		for _, scenario := range []struct {
			name     string
			store    RuntimeBarrierRecoveryStartStore
			starter  RuntimeBarrierRecoveryStarter
			schedule RuntimeBarrierRecoveryStartSchedule
		}{
			{"nil store", nil, starter, valid},
			{"nil starter", store, nil, valid},
			{"zero poll", store, starter, RuntimeBarrierRecoveryStartSchedule{RoundTimeout: time.Second, BatchSize: 1}},
			{"negative poll", store, starter, RuntimeBarrierRecoveryStartSchedule{PollInterval: -time.Second, RoundTimeout: time.Second, BatchSize: 1}},
			{"zero round", store, starter, RuntimeBarrierRecoveryStartSchedule{PollInterval: time.Second, BatchSize: 1}},
			{"negative round", store, starter, RuntimeBarrierRecoveryStartSchedule{PollInterval: time.Second, RoundTimeout: -time.Second, BatchSize: 1}},
			{"zero batch", store, starter, RuntimeBarrierRecoveryStartSchedule{PollInterval: time.Second, RoundTimeout: time.Second}},
			{"negative batch", store, starter, RuntimeBarrierRecoveryStartSchedule{PollInterval: time.Second, RoundTimeout: time.Second, BatchSize: -1}},
			{"oversized batch", store, starter, RuntimeBarrierRecoveryStartSchedule{PollInterval: time.Second, RoundTimeout: time.Second, BatchSize: 1001}},
		} {
			t.Run(scenario.name, func(t *testing.T) {
				worker, err := NewRuntimeBarrierRecoveryStartWorker(scenario.store, scenario.starter, scenario.schedule, nil)
				require.Error(t, err)
				require.Nil(t, worker)
			})
		}
		for _, batch := range []int{1, 1000} {
			worker, err := NewRuntimeBarrierRecoveryStartWorker(store, starter,
				RuntimeBarrierRecoveryStartSchedule{PollInterval: time.Second, RoundTimeout: 2 * time.Second, BatchSize: batch}, nil)
			require.NoError(t, err)
			require.NotNil(t, worker)
		}
		require.Empty(t, calls.snapshot().events, "construction must not start work")
	})

	t.Run("one bounded page uses only the original receipt and verified start acknowledgement", func(t *testing.T) {
		receipts := pendingStartWorkerReceipts(t, 2)
		original := clonePendingStartWorkerReceipts(receipts)
		calls, store, starter := pendingStartWorkerDependencies()
		store.list = func(context.Context, string, int) ([]ports.RuntimeBarrierRecoveryReceipt, error) {
			return receipts, nil
		}
		worker := newPendingStartWorker(t, store, starter, pendingStartWorkerSchedule(3))
		before := time.Now()

		require.NoError(t, worker.RunOnce(context.Background()))

		snapshot := calls.snapshot()
		require.Equal(t, []string{"list:", "ensure:" + receipts[0].Command.RequestID,
			"confirm:" + receipts[0].Command.RequestID, "ensure:" + receipts[1].Command.RequestID,
			"confirm:" + receipts[1].Command.RequestID}, snapshot.events)
		require.Equal(t, []pendingStartWorkerList{{after: "", limit: 3}}, snapshot.listed)
		require.Equal(t, original, snapshot.ensured)
		require.Equal(t, []pendingStartWorkerConfirmation{
			{id: receipts[0].Command.RequestID, fingerprint: receipts[0].RequestFingerprint},
			{id: receipts[1].Command.RequestID, fingerprint: receipts[1].RequestFingerprint},
		}, snapshot.confirmed)
		require.Equal(t, original, receipts, "the durable command, policy and barrier fact cannot be refreshed or mutated")
		var deadline time.Time
		for index, ctx := range snapshot.contexts {
			actual, ok := ctx.Deadline()
			require.True(t, ok, "all calls share the round budget")
			if index == 0 {
				deadline = actual
			}
			require.Equal(t, deadline, actual, "a later call must not receive a fresh timeout")
		}
		require.False(t, deadline.Before(before))
		require.False(t, deadline.After(time.Now().Add(pendingStartWorkerSchedule(3).RoundTimeout)))
	})
}

func TestRuntimeBarrierRecoveryStartWorkerRetainsUnknownAndCombinedErrors(t *testing.T) {
	receipts := pendingStartWorkerReceipts(t, 3)
	unknownStart := errors.New("engine start acceptance is unknown")
	unknownConfirm := errors.New("database confirmation result is unknown")
	calls, store, starter := pendingStartWorkerDependencies()
	store.list = func(context.Context, string, int) ([]ports.RuntimeBarrierRecoveryReceipt, error) {
		return receipts, nil
	}
	starter.ensure = func(_ context.Context, receipt ports.RuntimeBarrierRecoveryReceipt) error {
		switch receipt.Command.RequestID {
		case receipts[0].Command.RequestID:
			return unknownStart
		case receipts[1].Command.RequestID:
			return ports.ErrRequestConflict
		default:
			return nil
		}
	}
	store.confirm = func(context.Context, string, string) error { return unknownConfirm }
	worker := newPendingStartWorker(t, store, starter, pendingStartWorkerSchedule(3))

	err := worker.RunOnce(context.Background())

	require.ErrorIs(t, err, unknownStart)
	require.ErrorIs(t, err, ports.ErrRequestConflict)
	require.ErrorIs(t, err, unknownConfirm)
	snapshot := calls.snapshot()
	require.Equal(t, receipts, snapshot.ensured, "one failed receipt cannot starve the rest of the page")
	require.Equal(t, []pendingStartWorkerConfirmation{{id: receipts[2].Command.RequestID,
		fingerprint: receipts[2].RequestFingerprint}}, snapshot.confirmed)
	require.Len(t, snapshot.listed, 1, "RunOnce consumes only one page")
}

func TestRuntimeBarrierRecoveryStartWorkerCursorFairnessAndWholePageAdmission(t *testing.T) {
	t.Run("failed head advances and low new requests are found after wrap", func(t *testing.T) {
		receipts := pendingStartWorkerReceipts(t, 5)
		pending := map[string]bool{}
		for _, receipt := range receipts[1:] {
			pending[receipt.Command.RequestID] = true
		}
		failed := errors.New("first pending start stays unavailable")
		calls, store, starter := pendingStartWorkerDependencies()
		store.list = func(_ context.Context, after string, limit int) ([]ports.RuntimeBarrierRecoveryReceipt, error) {
			var page []ports.RuntimeBarrierRecoveryReceipt
			for _, receipt := range receipts {
				if pending[receipt.Command.RequestID] && receipt.Command.RequestID > after {
					page = append(page, receipt)
					if len(page) == limit {
						break
					}
				}
			}
			return page, nil
		}
		starter.ensure = func(_ context.Context, receipt ports.RuntimeBarrierRecoveryReceipt) error {
			if receipt.Command.RequestID == receipts[1].Command.RequestID {
				return failed
			}
			return nil
		}
		store.confirm = func(_ context.Context, id, _ string) error { delete(pending, id); return nil }
		worker := newPendingStartWorker(t, store, starter, pendingStartWorkerSchedule(2))
		require.ErrorIs(t, worker.RunOnce(context.Background()), failed)
		require.NoError(t, worker.RunOnce(context.Background()))
		pending[receipts[0].Command.RequestID] = true
		require.NoError(t, worker.RunOnce(context.Background()), "the empty page wraps without dispatch")
		require.Len(t, calls.snapshot().ensured, 4)
		require.ErrorIs(t, worker.RunOnce(context.Background()), failed)
		snapshot := calls.snapshot()
		require.Equal(t, []pendingStartWorkerList{{after: "", limit: 2},
			{after: receipts[2].Command.RequestID, limit: 2},
			{after: receipts[4].Command.RequestID, limit: 2}, {after: "", limit: 2}}, snapshot.listed)
		require.Equal(t, []ports.RuntimeBarrierRecoveryReceipt{receipts[1], receipts[2], receipts[3], receipts[4], receipts[0], receipts[1]}, snapshot.ensured)
		require.Equal(t, map[string]bool{receipts[1].Command.RequestID: true}, pending)
	})

	t.Run("complete short page resets even when its attempted receipt fails", func(t *testing.T) {
		receipt := pendingStartWorkerReceipts(t, 1)[0]
		failure := errors.New("still pending")
		calls, store, starter := pendingStartWorkerDependencies()
		store.list = func(context.Context, string, int) ([]ports.RuntimeBarrierRecoveryReceipt, error) {
			return []ports.RuntimeBarrierRecoveryReceipt{receipt}, nil
		}
		starter.ensure = func(context.Context, ports.RuntimeBarrierRecoveryReceipt) error { return failure }
		worker := newPendingStartWorker(t, store, starter, pendingStartWorkerSchedule(2))
		require.ErrorIs(t, worker.RunOnce(context.Background()), failure)
		require.ErrorIs(t, worker.RunOnce(context.Background()), failure)
		require.Equal(t, []pendingStartWorkerList{{after: "", limit: 2}, {after: "", limit: 2}}, calls.snapshot().listed)
		require.Empty(t, calls.snapshot().confirmed)
	})

	for _, scenario := range []string{"empty ID", "duplicate", "descending", "not after cursor", "oversized page", "invalid ID", "oversized ID", "invalid leading character", "list error"} {
		t.Run(scenario+" rejects the whole page and preserves the previous cursor", func(t *testing.T) {
			receipts := pendingStartWorkerReceipts(t, 5)
			bad := clonePendingStartWorkerReceipts(receipts[2:4])
			listFailure := errors.New("pending query failed after producing rows")
			var pageErr error
			switch scenario {
			case "empty ID":
				bad[1].Command.RequestID = ""
			case "duplicate":
				bad[1] = bad[0]
			case "descending":
				bad[0], bad[1] = bad[1], bad[0]
			case "not after cursor":
				bad[1] = receipts[1]
			case "oversized page":
				bad = append(bad, receipts[4])
			case "invalid ID":
				bad[1].Command.RequestID += " invalid"
			case "oversized ID":
				bad[1].Command.RequestID = strings.Repeat("z", 201)
			case "invalid leading character":
				bad[1].Command.RequestID = "~invalid"
			case "list error":
				pageErr = listFailure
			}
			calls, store, starter := pendingStartWorkerDependencies()
			lists := 0
			store.list = func(context.Context, string, int) ([]ports.RuntimeBarrierRecoveryReceipt, error) {
				lists++
				switch lists {
				case 1:
					return receipts[:2], nil
				case 2:
					return bad, pageErr
				default:
					return receipts[2:3], nil
				}
			}
			worker := newPendingStartWorker(t, store, starter, pendingStartWorkerSchedule(2))
			require.NoError(t, worker.RunOnce(context.Background()))
			err := worker.RunOnce(context.Background())
			require.Error(t, err)
			if pageErr != nil {
				require.ErrorIs(t, err, listFailure)
			}
			require.Equal(t, receipts[:2], calls.snapshot().ensured, "even the valid prefix of a bad page cannot dispatch")
			require.Len(t, calls.snapshot().confirmed, 2)
			require.NoError(t, worker.RunOnce(context.Background()))
			snapshot := calls.snapshot()
			require.Equal(t, []pendingStartWorkerList{{after: "", limit: 2},
				{after: receipts[1].Command.RequestID, limit: 2},
				{after: receipts[1].Command.RequestID, limit: 2}}, snapshot.listed)
			require.Equal(t, receipts[:3], snapshot.ensured)
		})
	}
}

func TestRuntimeBarrierRecoveryStartWorkerRetriesOriginalAfterUnknownConfirmation(t *testing.T) {
	for _, restart := range []bool{false, true} {
		t.Run(fmt.Sprintf("restart=%t", restart), func(t *testing.T) {
			receipt := pendingStartWorkerReceipts(t, 1)[0]
			original := clonePendingStartWorkerReceipts([]ports.RuntimeBarrierRecoveryReceipt{receipt})[0]
			pending := true
			confirmAttempts := 0
			unknown := errors.New("confirmation acknowledgement lost")
			calls, store, starter := pendingStartWorkerDependencies()
			store.list = func(_ context.Context, after string, _ int) ([]ports.RuntimeBarrierRecoveryReceipt, error) {
				if pending && receipt.Command.RequestID > after {
					return []ports.RuntimeBarrierRecoveryReceipt{receipt}, nil
				}
				return nil, nil
			}
			store.confirm = func(context.Context, string, string) error {
				confirmAttempts++
				if confirmAttempts == 1 {
					return unknown
				}
				pending = false
				return nil
			}
			worker := newPendingStartWorker(t, store, starter, pendingStartWorkerSchedule(1))
			require.ErrorIs(t, worker.RunOnce(context.Background()), unknown)
			require.True(t, pending)
			if restart {
				worker = newPendingStartWorker(t, store, starter, pendingStartWorkerSchedule(1))
			} else {
				require.NoError(t, worker.RunOnce(context.Background()), "a full page retains its cursor until the next empty page")
				require.Len(t, calls.snapshot().ensured, 1)
			}
			require.NoError(t, worker.RunOnce(context.Background()))
			require.False(t, pending)
			snapshot := calls.snapshot()
			require.Equal(t, []ports.RuntimeBarrierRecoveryReceipt{original, original}, snapshot.ensured)
			require.Equal(t, []pendingStartWorkerConfirmation{{id: original.Command.RequestID, fingerprint: original.RequestFingerprint},
				{id: original.Command.RequestID, fingerprint: original.RequestFingerprint}}, snapshot.confirmed)
			require.Equal(t, original, receipt)
		})
	}
}

func TestRuntimeBarrierRecoveryStartWorkerCancellationJoinsEveryActualCallback(t *testing.T) {
	for _, stage := range []string{"list", "ensure", "confirm"} {
		for _, deadline := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/deadline=%t", stage, deadline), func(t *testing.T) {
				synctest.Test(t, func(t *testing.T) {
					receipts := pendingStartWorkerReceipts(t, 2)
					calls, store, starter := pendingStartWorkerDependencies()
					hold := newPendingStartWorkerHold()
					store.list = func(ctx context.Context, _ string, _ int) ([]ports.RuntimeBarrierRecoveryReceipt, error) {
						if stage == "list" {
							hold.wait(ctx)
						}
						return receipts, nil
					}
					starter.ensure = func(ctx context.Context, _ ports.RuntimeBarrierRecoveryReceipt) error {
						if stage == "ensure" {
							hold.wait(ctx)
						}
						return nil
					}
					store.confirm = func(ctx context.Context, _, _ string) error {
						if stage == "confirm" {
							hold.wait(ctx)
						}
						return nil
					}
					schedule := pendingStartWorkerSchedule(2)
					worker := newPendingStartWorker(t, store, starter, schedule)
					ctx, cancel := context.WithCancel(context.Background())
					task := startPendingStartWorkerTask(func() error { return worker.RunOnce(ctx) })
					defer func() { cancel(); hold.release(); task.join(t) }()
					waitPendingStartWorkerHeld(t, hold, task)
					if deadline {
						time.Sleep(schedule.RoundTimeout)
					} else {
						cancel()
					}
					synctest.Wait()
					select {
					case <-hold.cancelled:
					default:
						t.Fatal("the actual held dependency did not receive cancellation")
					}
					select {
					case <-task.done:
						t.Fatal("worker returned before its held dependency settled")
					default:
					}
					hold.release()
					err := task.join(t)
					if deadline {
						require.ErrorIs(t, err, context.DeadlineExceeded)
					} else {
						require.ErrorIs(t, err, context.Canceled)
					}
					select {
					case <-hold.returned:
					default:
						t.Fatal("the original callback was not joined")
					}
					snapshot := calls.snapshot()
					require.Len(t, snapshot.listed, 1)
					switch stage {
					case "list":
						require.Empty(t, snapshot.ensured)
						require.Empty(t, snapshot.confirmed)
					case "ensure":
						require.Equal(t, receipts[:1], snapshot.ensured)
						require.Empty(t, snapshot.confirmed)
					case "confirm":
						require.Equal(t, receipts[:1], snapshot.ensured)
						require.Len(t, snapshot.confirmed, 1)
					}
					if stage != "list" {
						// A cancelled partially processed page must not wrap or skip its unattempted tail.
						store.list = func(context.Context, string, int) ([]ports.RuntimeBarrierRecoveryReceipt, error) {
							return receipts[1:], nil
						}
						starter.ensure = nil
						store.confirm = nil
						require.NoError(t, worker.RunOnce(context.Background()))
						last := calls.snapshot()
						require.Equal(t, receipts[0].Command.RequestID, last.listed[1].after)
						require.Equal(t, receipts, last.ensured)
					}
				})
			})
		}
	}
}

func TestRuntimeBarrierRecoveryStartWorkerRunAndSerialGateActuallyJoin(t *testing.T) {
	t.Run("Run starts immediately and cancellation joins its timer", func(t *testing.T) {
		synctest.Test(t, func(t *testing.T) {
			calls, store, starter := pendingStartWorkerDependencies()
			schedule := pendingStartWorkerSchedule(2)
			worker := newPendingStartWorker(t, store, starter, schedule)
			ctx, cancel := context.WithCancel(context.Background())
			task := startPendingStartWorkerTask(func() error { worker.Run(ctx); return nil })
			defer func() { cancel(); task.join(t) }()
			synctest.Wait()
			require.Len(t, calls.snapshot().listed, 1, "startup must not wait for the poll timer")
			time.Sleep(schedule.PollInterval - time.Nanosecond)
			synctest.Wait()
			require.Len(t, calls.snapshot().listed, 1)
			time.Sleep(time.Nanosecond)
			synctest.Wait()
			require.Len(t, calls.snapshot().listed, 2)
			cancel()
			require.NoError(t, task.join(t))
			time.Sleep(2 * schedule.PollInterval)
			require.Len(t, calls.snapshot().listed, 2, "no poll may survive Run's return")
		})
	})

	t.Run("already stopped Run performs no read", func(t *testing.T) {
		calls, store, starter := pendingStartWorkerDependencies()
		worker := newPendingStartWorker(t, store, starter, pendingStartWorkerSchedule(2))
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		worker.Run(ctx)
		require.ErrorIs(t, worker.RunOnce(ctx), context.Canceled)
		require.Empty(t, calls.snapshot().events)
	})

	t.Run("Run cancellation waits for its original Ensure without confirmation", func(t *testing.T) {
		synctest.Test(t, func(t *testing.T) {
			receipts := pendingStartWorkerReceipts(t, 1)
			calls, store, starter := pendingStartWorkerDependencies()
			store.list = func(context.Context, string, int) ([]ports.RuntimeBarrierRecoveryReceipt, error) {
				return receipts, nil
			}
			hold := newPendingStartWorkerHold()
			starter.ensure = func(ctx context.Context, _ ports.RuntimeBarrierRecoveryReceipt) error { hold.wait(ctx); return nil }
			worker := newPendingStartWorker(t, store, starter, pendingStartWorkerSchedule(1))
			ctx, cancel := context.WithCancel(context.Background())
			task := startPendingStartWorkerTask(func() error { worker.Run(ctx); return nil })
			defer func() { cancel(); hold.release(); task.join(t) }()
			waitPendingStartWorkerHeld(t, hold, task)
			cancel()
			synctest.Wait()
			select {
			case <-hold.cancelled:
			default:
				t.Fatal("Ensure did not receive Run cancellation")
			}
			select {
			case <-task.done:
				t.Fatal("Run detached its held Ensure")
			default:
			}
			hold.release()
			require.NoError(t, task.join(t))
			require.Equal(t, receipts, calls.snapshot().ensured)
			require.Empty(t, calls.snapshot().confirmed)
			require.Len(t, calls.snapshot().listed, 1)
		})
	})

	for _, deadline := range []bool{false, true} {
		t.Run(fmt.Sprintf("waiting RunOnce gate is cancellable and shares round budget/deadline=%t", deadline), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				receipts := pendingStartWorkerReceipts(t, 1)
				calls, store, starter := pendingStartWorkerDependencies()
				store.list = func(context.Context, string, int) ([]ports.RuntimeBarrierRecoveryReceipt, error) {
					return receipts, nil
				}
				hold := newPendingStartWorkerHold()
				starter.ensure = func(ctx context.Context, _ ports.RuntimeBarrierRecoveryReceipt) error { hold.wait(ctx); return nil }
				schedule := pendingStartWorkerSchedule(1)
				worker := newPendingStartWorker(t, store, starter, schedule)
				firstCtx, cancelFirst := context.WithCancel(context.Background())
				first := startPendingStartWorkerTask(func() error { return worker.RunOnce(firstCtx) })
				var second *pendingStartWorkerTask
				secondCtx, cancelSecond := context.WithCancel(context.Background())
				defer func() {
					cancelFirst()
					cancelSecond()
					hold.release()
					first.join(t)
					if second != nil {
						second.join(t)
					}
				}()
				waitPendingStartWorkerHeld(t, hold, first)
				second = startPendingStartWorkerTask(func() error { return worker.RunOnce(secondCtx) })
				synctest.Wait()
				require.Len(t, calls.snapshot().listed, 1, "waiting for the cursor gate must not read a second page")
				if deadline {
					time.Sleep(schedule.RoundTimeout)
				} else {
					cancelSecond()
				}
				synctest.Wait()
				err := second.join(t)
				if deadline {
					require.ErrorIs(t, err, context.DeadlineExceeded)
				} else {
					require.ErrorIs(t, err, context.Canceled)
				}
				require.Len(t, calls.snapshot().listed, 1)
				require.Empty(t, calls.snapshot().confirmed)
				cancelFirst()
				hold.release()
				require.Error(t, first.join(t))
				require.Empty(t, calls.snapshot().confirmed)
			})
		})
	}
}

func pendingStartWorkerSchedule(batch int) RuntimeBarrierRecoveryStartSchedule {
	return RuntimeBarrierRecoveryStartSchedule{PollInterval: time.Minute, RoundTimeout: 5 * time.Second, BatchSize: batch}
}

func newPendingStartWorker(t *testing.T, store RuntimeBarrierRecoveryStartStore, starter RuntimeBarrierRecoveryStarter,
	schedule RuntimeBarrierRecoveryStartSchedule,
) *RuntimeBarrierRecoveryStartWorker {
	t.Helper()
	worker, err := NewRuntimeBarrierRecoveryStartWorker(store, starter, schedule, slog.New(slog.NewTextHandler(io.Discard, nil)))
	require.NoError(t, err)
	return worker
}

func pendingStartWorkerReceipts(t *testing.T, count int) []ports.RuntimeBarrierRecoveryReceipt {
	t.Helper()
	receipts := make([]ports.RuntimeBarrierRecoveryReceipt, 0, count)
	for index := 0; index < count; index++ {
		agentID := fmt.Sprintf("agent-worker-%03d", index)
		barrierID := fmt.Sprintf("barrier-%03d\x00\u0085original", index)
		requestID, err := ports.RuntimeBarrierRecoveryRequestID("org-worker", agentID, barrierID)
		require.NoError(t, err)
		command := ports.RuntimeBarrierRebuildCommand{RequestID: requestID, OrganizationID: "org-worker",
			ActorPrincipalID: "agent-controller", AgentID: agentID, TemplateID: "template-original", TemplateRevision: 7}
		payload, err := json.Marshal(command)
		require.NoError(t, err)
		digest := sha256.Sum256(payload)
		acceptedAt := time.Date(2026, 10, 22, 20, 0, index, 123456000, time.UTC)
		receipts = append(receipts, ports.RuntimeBarrierRecoveryReceipt{
			Fact: ports.RuntimeBarrierResult{OrganizationID: "org-worker", AgentID: agentID, RuntimeRevision: "runtime-original",
				Barrier: &ports.RuntimeBarrier{BarrierID: barrierID, Reason: ports.ExecutionRuntimeBarrierRequired,
					RuntimeExecutionID: "execution-original"}},
			Policy:  domain.RuntimeBarrierRecoveryPolicy{OrganizationID: "org-worker", Revision: 9, Mode: "auto", CooldownMS: 300000},
			Command: command, RequestFingerprint: hex.EncodeToString(digest[:]), AcceptedAt: acceptedAt,
			CooldownUntil: acceptedAt.Add(5 * time.Minute),
		})
	}
	slices.SortFunc(receipts, func(left, right ports.RuntimeBarrierRecoveryReceipt) int {
		return strings.Compare(left.Command.RequestID, right.Command.RequestID)
	})
	return receipts
}

func clonePendingStartWorkerReceipts(receipts []ports.RuntimeBarrierRecoveryReceipt) []ports.RuntimeBarrierRecoveryReceipt {
	if receipts == nil {
		return nil
	}
	cloned := slices.Clone(receipts)
	for index := range cloned {
		if cloned[index].Fact.Barrier != nil {
			barrier := *cloned[index].Fact.Barrier
			cloned[index].Fact.Barrier = &barrier
		}
	}
	return cloned
}

type pendingStartWorkerList struct {
	after string
	limit int
}
type pendingStartWorkerConfirmation struct{ id, fingerprint string }
type pendingStartWorkerSnapshot struct {
	events    []string
	listed    []pendingStartWorkerList
	ensured   []ports.RuntimeBarrierRecoveryReceipt
	confirmed []pendingStartWorkerConfirmation
	contexts  []context.Context
}
type pendingStartWorkerCalls struct {
	mu    sync.Mutex
	state pendingStartWorkerSnapshot
}

func (calls *pendingStartWorkerCalls) record(ctx context.Context, kind, id, fingerprint string, limit int, receipt ports.RuntimeBarrierRecoveryReceipt) {
	calls.mu.Lock()
	defer calls.mu.Unlock()
	calls.state.events = append(calls.state.events, kind+":"+id)
	calls.state.contexts = append(calls.state.contexts, ctx)
	switch kind {
	case "list":
		calls.state.listed = append(calls.state.listed, pendingStartWorkerList{after: id, limit: limit})
	case "ensure":
		calls.state.ensured = append(calls.state.ensured, clonePendingStartWorkerReceipts([]ports.RuntimeBarrierRecoveryReceipt{receipt})[0])
	case "confirm":
		calls.state.confirmed = append(calls.state.confirmed, pendingStartWorkerConfirmation{id: id, fingerprint: fingerprint})
	}
}

func (calls *pendingStartWorkerCalls) snapshot() pendingStartWorkerSnapshot {
	calls.mu.Lock()
	defer calls.mu.Unlock()
	return pendingStartWorkerSnapshot{events: slices.Clone(calls.state.events), listed: slices.Clone(calls.state.listed),
		ensured: clonePendingStartWorkerReceipts(calls.state.ensured), confirmed: slices.Clone(calls.state.confirmed),
		contexts: slices.Clone(calls.state.contexts)}
}

type pendingStartWorkerStoreStub struct {
	calls   *pendingStartWorkerCalls
	list    func(context.Context, string, int) ([]ports.RuntimeBarrierRecoveryReceipt, error)
	confirm func(context.Context, string, string) error
}

func (store *pendingStartWorkerStoreStub) ListPendingRuntimeBarrierRecoveryStarts(ctx context.Context, after string, limit int) ([]ports.RuntimeBarrierRecoveryReceipt, error) {
	store.calls.record(ctx, "list", after, "", limit, ports.RuntimeBarrierRecoveryReceipt{})
	if store.list != nil {
		return store.list(ctx, after, limit)
	}
	return nil, nil
}

func (store *pendingStartWorkerStoreStub) ConfirmRuntimeBarrierRecoveryStarted(ctx context.Context, id, fingerprint string) error {
	store.calls.record(ctx, "confirm", id, fingerprint, 0, ports.RuntimeBarrierRecoveryReceipt{})
	if store.confirm != nil {
		return store.confirm(ctx, id, fingerprint)
	}
	return nil
}

type pendingStartWorkerStarterStub struct {
	calls  *pendingStartWorkerCalls
	ensure func(context.Context, ports.RuntimeBarrierRecoveryReceipt) error
}

func (starter *pendingStartWorkerStarterStub) EnsureRuntimeBarrierRecoveryStarted(ctx context.Context, receipt ports.RuntimeBarrierRecoveryReceipt) error {
	starter.calls.record(ctx, "ensure", receipt.Command.RequestID, "", 0, receipt)
	if starter.ensure != nil {
		return starter.ensure(ctx, receipt)
	}
	return nil
}

func pendingStartWorkerDependencies() (*pendingStartWorkerCalls, *pendingStartWorkerStoreStub, *pendingStartWorkerStarterStub) {
	calls := &pendingStartWorkerCalls{}
	return calls, &pendingStartWorkerStoreStub{calls: calls}, &pendingStartWorkerStarterStub{calls: calls}
}

type pendingStartWorkerHold struct {
	started, cancelled, released, returned         chan struct{}
	startOnce, cancelOnce, releaseOnce, returnOnce sync.Once
}

func newPendingStartWorkerHold() *pendingStartWorkerHold {
	return &pendingStartWorkerHold{started: make(chan struct{}), cancelled: make(chan struct{}),
		released: make(chan struct{}), returned: make(chan struct{})}
}

func (hold *pendingStartWorkerHold) wait(ctx context.Context) {
	hold.startOnce.Do(func() { close(hold.started) })
	select {
	case <-ctx.Done():
		hold.cancelOnce.Do(func() { close(hold.cancelled) })
		<-hold.released
	case <-hold.released:
	}
	hold.returnOnce.Do(func() { close(hold.returned) })
}

func (hold *pendingStartWorkerHold) release() { hold.releaseOnce.Do(func() { close(hold.released) }) }

type pendingStartWorkerTask struct {
	done chan struct{}
	err  error
}

func startPendingStartWorkerTask(run func() error) *pendingStartWorkerTask {
	task := &pendingStartWorkerTask{done: make(chan struct{})}
	go func() { defer close(task.done); task.err = run() }()
	return task
}

func (task *pendingStartWorkerTask) join(t *testing.T) error {
	t.Helper()
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	select {
	case <-task.done:
		return task.err
	case <-timer.C:
		t.Fatal("worker did not join after owned callbacks were released")
		return nil
	}
}

func waitPendingStartWorkerHeld(t *testing.T, hold *pendingStartWorkerHold, task *pendingStartWorkerTask) {
	t.Helper()
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	select {
	case <-hold.started:
	case <-task.done:
		t.Fatalf("worker returned before its original callback started: %v", task.err)
	case <-timer.C:
		t.Fatal("worker did not call its owned dependency")
	}
}
