package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

func TestCredentialCleanupWaitsBeforeFirstPassAndAfterEveryCompletion(t *testing.T) {
	for _, outcome := range []string{"empty", "full", "failure"} {
		t.Run(outcome, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				var output bytes.Buffer
				var calls []time.Time
				var callsMu sync.Mutex
				readCalls := func() []time.Time {
					callsMu.Lock()
					defer callsMu.Unlock()
					return append([]time.Time(nil), calls...)
				}
				release := make(chan struct{})
				unblock := sync.OnceFunc(func() { close(release) })
				defer unblock()
				stop := startCredentialCleanup(ctx, func(actual context.Context) (int64, error) {
					callsMu.Lock()
					calls = append(calls, time.Now())
					first := len(calls) == 1
					callsMu.Unlock()
					if first {
						select {
						case <-release:
						case <-actual.Done():
							return 0, actual.Err()
						}
					}
					if outcome == "full" {
						return 500, nil
					}
					if outcome == "failure" {
						return 0, errors.New("postgres://credential-canary:secret@private/identity")
					}
					return 0, nil
				}, slog.New(slog.NewJSONHandler(&output, nil)))
				defer stop()
				synctest.Wait()
				time.Sleep(time.Minute - time.Nanosecond)
				synctest.Wait()
				if len(readCalls()) != 0 {
					t.Fatal("cleanup ran before its first full interval")
				}
				time.Sleep(time.Nanosecond)
				synctest.Wait()
				if len(readCalls()) != 1 {
					t.Fatal("cleanup did not start exactly one pass after one minute")
				}
				time.Sleep(3 * time.Minute)
				synctest.Wait()
				if len(readCalls()) != 1 {
					t.Fatal("cleanup overlapped a held pass")
				}
				completed := time.Now()
				unblock()
				synctest.Wait()
				time.Sleep(time.Minute - time.Nanosecond)
				synctest.Wait()
				if len(readCalls()) != 1 {
					t.Fatal("cleanup caught up missed ticks or retried before the next full interval")
				}
				time.Sleep(time.Nanosecond)
				synctest.Wait()
				if observed := readCalls(); len(observed) != 2 || observed[1].Sub(completed) != time.Minute {
					t.Fatal("cleanup did not measure its next interval from completion")
				}
				stop()
				time.Sleep(2 * time.Minute)
				synctest.Wait()
				if len(readCalls()) != 2 {
					t.Fatal("cleanup restarted after stop returned")
				}
				if outcome != "failure" {
					if output.Len() != 0 {
						t.Fatal("successful cleanup emitted an unexpected failure log")
					}
					return
				}
				if strings.Contains(output.String(), "credential-canary") || strings.Contains(output.String(), "secret") {
					t.Fatal("cleanup logged a private storage cause")
				}
				decoder := json.NewDecoder(&output)
				for range 2 {
					var row map[string]any
					if err := decoder.Decode(&row); err != nil {
						t.Fatal(err)
					}
					if len(row) != 4 || row["level"] != "WARN" || row["msg"] != "Identity credential attempt cleanup failed" || row["error_class"] != "credential_cleanup_failure" {
						t.Fatal("cleanup log lost its fixed bounded failure shape")
					}
				}
				if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
					t.Fatal("cleanup emitted more than one failure per completed pass")
				}
			})
		})
	}
}

func TestCredentialCleanupStopCancelsAndJoinsEvenWithLiveParent(t *testing.T) {
	for _, parentCancelled := range []bool{false, true} {
		name := "serve-return"
		if parentCancelled {
			name = "parent-cancel"
		}
		t.Run(name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				entered, cancelled, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
				var returned atomic.Bool
				var output bytes.Buffer
				stop := startCredentialCleanup(ctx, func(actual context.Context) (int64, error) {
					close(entered)
					<-actual.Done()
					close(cancelled)
					<-release
					returned.Store(true)
					return 0, actual.Err()
				}, slog.New(slog.NewJSONHandler(&output, nil)))
				unblock := sync.OnceFunc(func() { close(release) })
				defer func() { unblock(); stop() }()
				synctest.Wait()
				time.Sleep(time.Minute)
				synctest.Wait()
				select {
				case <-entered:
				default:
					t.Fatal("cleanup did not enter the held operation")
				}
				if parentCancelled {
					cancel()
				}
				joined := make(chan struct{})
				go func() { stop(); close(joined) }()
				synctest.Wait()
				select {
				case <-cancelled:
				default:
					t.Fatal("stop failed to cancel the in-flight cleanup")
				}
				select {
				case <-joined:
					t.Fatal("stop returned before the in-flight operation and rollback joined")
				default:
				}
				unblock()
				synctest.Wait()
				<-joined
				stop()
				if !returned.Load() || output.Len() != 0 || !parentCancelled && ctx.Err() != nil {
					t.Fatal("stop lost join, logged expected cancellation, or cancelled its parent")
				}
			})
		})
	}
}

func TestCredentialCleanupCancelledBeforeStartNeverCallsRepository(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		calls := 0
		stop := startCredentialCleanup(ctx, func(context.Context) (int64, error) { calls++; return 0, nil }, slog.New(slog.NewJSONHandler(io.Discard, nil)))
		defer stop()
		time.Sleep(2 * time.Minute)
		synctest.Wait()
		stop()
		if calls != 0 {
			t.Fatal("already-cancelled cleanup started database work")
		}
	})
}
