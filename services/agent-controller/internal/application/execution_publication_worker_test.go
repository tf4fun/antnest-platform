package application

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
	"go.opentelemetry.io/otel/trace"
)

type publicationOrganizationsStub struct {
	list func(context.Context, string, int) ([]string, error)
}

func (source publicationOrganizationsStub) ListExecutionOrganizations(ctx context.Context, after string, limit int) ([]string, error) {
	return source.list(ctx, after, limit)
}

type snapshotPublisherFunc func(context.Context, string) (ports.ExecutionAcknowledgement, error)

func (publish snapshotPublisherFunc) Publish(ctx context.Context, organization string) (ports.ExecutionAcknowledgement, error) {
	return publish(ctx, organization)
}

func publicationSchedule() ExecutionPublicationSchedule {
	return ExecutionPublicationSchedule{ResyncInterval: time.Minute, RetryInterval: time.Second,
		MaxRetryInterval: 4 * time.Second, RequestTimeout: 5 * time.Second}
}

func publicationWorker(t *testing.T, source publicationOrganizationsStub, publish snapshotPublisherFunc) *ExecutionPublicationWorker {
	t.Helper()
	worker, err := NewExecutionPublicationWorker(source, publish, publicationSchedule(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	require.NoError(t, err)
	return worker
}

func onePublicationOrganization() publicationOrganizationsStub {
	return publicationOrganizationsStub{list: func(context.Context, string, int) ([]string, error) {
		return []string{"org-1"}, nil
	}}
}

func runPublicationWorker(ctx context.Context, worker *ExecutionPublicationWorker) <-chan struct{} {
	done := make(chan struct{})
	go func() { defer close(done); worker.Run(ctx) }()
	return done
}

func TestPublicationWorkerStartupPeriodicAndCoalescedCommitHints(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		parents := make(chan trace.SpanContext, 10)
		release := make(chan struct{})
		first := true
		worker := publicationWorker(t, onePublicationOrganization(), func(ctx context.Context, org string) (ports.ExecutionAcknowledgement, error) {
			require.Equal(t, "org-1", org)
			require.NoError(t, ctx.Err())
			parents <- trace.SpanContextFromContext(ctx)
			if first {
				first = false
				select {
				case <-release:
				case <-ctx.Done():
					return ports.ExecutionAcknowledgement{}, ctx.Err()
				}
			}
			return ports.ExecutionAcknowledgement{}, nil
		})
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		done := runPublicationWorker(ctx, worker)
		synctest.Wait()
		require.Len(t, parents, 1)
		require.False(t, (<-parents).IsValid())
		parent := trace.NewSpanContext(trace.SpanContextConfig{TraceID: trace.TraceID{1}, SpanID: trace.SpanID{2}, TraceFlags: trace.FlagsSampled})
		request, cancelRequest := context.WithCancel(trace.ContextWithSpanContext(ctx, parent))
		worker.Notify(request, "org-1")
		worker.Notify(request, "org-1")
		cancelRequest()
		close(release)
		synctest.Wait()
		require.Len(t, parents, 1)
		require.Equal(t, parent, <-parents, "request cancellation must not cancel committed publication")
		time.Sleep(time.Minute)
		synctest.Wait()
		require.Len(t, parents, 1, "resend even without another revision or commit")
		require.False(t, (<-parents).IsValid(), "periodic repair must not retain an old request parent")
		cancel()
		<-done
	})
}

func TestPublicationWorkerBackoffCannotBeBypassedByNewCommits(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var attempts atomic.Int64
		var fail atomic.Bool
		fail.Store(true)
		worker := publicationWorker(t, onePublicationOrganization(), func(context.Context, string) (ports.ExecutionAcknowledgement, error) {
			attempts.Add(1)
			if fail.Load() {
				return ports.ExecutionAcknowledgement{}, errors.New("synthetic unavailable")
			}
			return ports.ExecutionAcknowledgement{}, nil
		})
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		done := runPublicationWorker(ctx, worker)
		synctest.Wait()
		require.EqualValues(t, 1, attempts.Load())
		for _, delay := range []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 4 * time.Second} {
			previous := attempts.Load()
			worker.Notify(ctx, "org-1")
			time.Sleep(delay - time.Nanosecond)
			synctest.Wait()
			require.Equal(t, previous, attempts.Load())
			time.Sleep(time.Nanosecond)
			synctest.Wait()
			require.Equal(t, previous+1, attempts.Load())
		}
		fail.Store(false)
		time.Sleep(4 * time.Second)
		synctest.Wait()
		previous := attempts.Load()
		worker.Notify(ctx, "org-1")
		synctest.Wait()
		require.Equal(t, previous+1, attempts.Load(), "successful recovery restores prompt commit-triggered publication")
		cancel()
		<-done
	})
}

func TestPublicationWorkerBoundsRequestsAndContinuesOtherOrganizations(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		attempts := make(chan string, 10)
		source := publicationOrganizationsStub{list: func(ctx context.Context, _ string, _ int) ([]string, error) {
			_, bounded := ctx.Deadline()
			require.True(t, bounded)
			return []string{"org-1", "org-2"}, nil
		}}
		worker := publicationWorker(t, source, func(ctx context.Context, org string) (ports.ExecutionAcknowledgement, error) {
			attempts <- org
			if org == "org-1" {
				<-ctx.Done()
				return ports.ExecutionAcknowledgement{}, ctx.Err()
			}
			return ports.ExecutionAcknowledgement{}, nil
		})
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		done := runPublicationWorker(ctx, worker)
		synctest.Wait()
		require.Len(t, attempts, 1)
		require.Equal(t, "org-1", <-attempts)
		time.Sleep(5 * time.Second)
		synctest.Wait()
		require.Len(t, attempts, 1)
		require.Equal(t, "org-2", <-attempts)
		cancel()
		<-done
	})
}

func TestPublicationWorkerShutdownCancelsActiveRequest(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var attempts atomic.Int64
		worker := publicationWorker(t, onePublicationOrganization(), func(ctx context.Context, _ string) (ports.ExecutionAcknowledgement, error) {
			attempts.Add(1)
			<-ctx.Done()
			return ports.ExecutionAcknowledgement{}, ctx.Err()
		})
		ctx, cancel := context.WithCancel(t.Context())
		done := runPublicationWorker(ctx, worker)
		synctest.Wait()
		worker.Notify(ctx, "org-2")
		cancel()
		<-done
		require.EqualValues(t, 1, attempts.Load())
	})
}

func TestPublicationWorkerRejectsInvalidSchedule(t *testing.T) {
	for _, change := range []func(*ExecutionPublicationSchedule){
		func(s *ExecutionPublicationSchedule) { s.ResyncInterval = 0 },
		func(s *ExecutionPublicationSchedule) { s.RetryInterval = 0 },
		func(s *ExecutionPublicationSchedule) { s.MaxRetryInterval = time.Nanosecond },
		func(s *ExecutionPublicationSchedule) { s.RequestTimeout = 0 },
	} {
		schedule := publicationSchedule()
		change(&schedule)
		_, err := NewExecutionPublicationWorker(onePublicationOrganization(), snapshotPublisherFunc(nil), schedule, nil)
		require.Error(t, err)
	}
}

func TestPublicationWorkerKeepsCommitsArrivingDuringPublication(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		entered, release := make(chan struct{}), make(chan struct{})
		var attempts atomic.Int64
		worker := publicationWorker(t, onePublicationOrganization(), func(context.Context, string) (ports.ExecutionAcknowledgement, error) {
			if attempts.Add(1) == 1 {
				close(entered)
				<-release
			}
			return ports.ExecutionAcknowledgement{}, nil
		})
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		done := runPublicationWorker(ctx, worker)
		<-entered
		worker.Notify(ctx, "org-1")
		worker.Notify(ctx, "org-1")
		close(release)
		synctest.Wait()
		require.EqualValues(t, 2, attempts.Load(), "the first success must not consume a later commit")
		cancel()
		<-done
	})
}

func TestPublicationWorkerScansAllPagesDespiteFailedOrganization(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		attempted, cursors := make(chan string, 210), make(chan string, 10)
		page := make([]string, 200)
		for i := range page {
			page[i] = fmt.Sprintf("org-%03d", i)
		}
		source := publicationOrganizationsStub{list: func(_ context.Context, after string, limit int) ([]string, error) {
			require.Equal(t, 200, limit)
			cursors <- after
			if after == "" {
				return page, nil
			}
			return []string{"org-200"}, nil
		}}
		worker := publicationWorker(t, source, func(_ context.Context, org string) (ports.ExecutionAcknowledgement, error) {
			attempted <- org
			if org == "org-000" {
				return ports.ExecutionAcknowledgement{}, errors.New("synthetic failure")
			}
			return ports.ExecutionAcknowledgement{}, nil
		})
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		done := runPublicationWorker(ctx, worker)
		synctest.Wait()
		require.Len(t, attempted, 201)
		require.Len(t, cursors, 2)
		require.Equal(t, "", <-cursors)
		require.Equal(t, "org-199", <-cursors)
		for i := range 201 {
			require.Equal(t, fmt.Sprintf("org-%03d", i), <-attempted)
		}
		cancel()
		<-done
	})
}

func TestPublicationWorkerBusyHintsDoNotPostponePeriodicScan(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var scans, publications atomic.Int64
		source := publicationOrganizationsStub{list: func(context.Context, string, int) ([]string, error) {
			scans.Add(1)
			return []string{"org-1"}, nil
		}}
		worker := publicationWorker(t, source, func(context.Context, string) (ports.ExecutionAcknowledgement, error) {
			publications.Add(1)
			return ports.ExecutionAcknowledgement{}, nil
		})
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		done := runPublicationWorker(ctx, worker)
		synctest.Wait()
		for range 5 {
			time.Sleep(10 * time.Second)
			worker.Notify(ctx, "org-1")
			synctest.Wait()
		}
		time.Sleep(10 * time.Second)
		synctest.Wait()
		require.EqualValues(t, 2, scans.Load())
		require.EqualValues(t, 7, publications.Load())
		cancel()
		<-done
	})
}

func TestPublicationWorkerMalformedPageBacksOffInsteadOfSpinning(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var scans atomic.Int64
		source := publicationOrganizationsStub{list: func(context.Context, string, int) ([]string, error) {
			scans.Add(1)
			return []string{"org-1", "org-1"}, nil
		}}
		worker := publicationWorker(t, source, func(context.Context, string) (ports.ExecutionAcknowledgement, error) {
			return ports.ExecutionAcknowledgement{}, nil
		})
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		done := runPublicationWorker(ctx, worker)
		synctest.Wait()
		require.EqualValues(t, 1, scans.Load())
		time.Sleep(time.Second)
		synctest.Wait()
		require.EqualValues(t, 2, scans.Load())
		cancel()
		<-done
	})
}
