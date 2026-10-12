package credentials

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

func TestEngineDummyPreparationAvoidsKernelButVerificationKeepsConfiguredCost(t *testing.T) {
	for _, policy := range []PasswordPolicy{
		{MemoryKiB: 17, Iterations: 1, Parallelism: 2},
		DefaultPasswordConfig().Policy,
		{MemoryKiB: 1048576, Iterations: 10, Parallelism: 16},
	} {
		t.Run(fmt.Sprint(policy.MemoryKiB), func(t *testing.T) {
			engine := testEngine(t, PasswordConfig{Policy: policy, MemoryBudgetKiB: policy.MemoryKiB, MaxConcurrent: 1})
			calls := 0
			engine.kernel = func([]byte, []byte, uint32, uint32, uint8, uint32) []byte {
				calls++
				t.Fatal("dummy preparation computed a password hash")
				return nil
			}
			first, err := engine.DummyHash(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			second, err := engine.DummyHash(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			stored, err := parseStoredPassword(first)
			if err != nil || stored.policy != policy || len(stored.salt) != 16 || len(stored.key) != 32 {
				t.Fatalf("dummy policy/encoding: policy=%+v error=%v", stored.policy, err)
			}
			other, err := parseStoredPassword(second)
			if err != nil || bytes.Equal(stored.salt, other.salt) || bytes.Equal(stored.key, other.key) || calls != 0 {
				t.Fatalf("dummy salt and target must both be random: error=%v calls=%d", err, calls)
			}
			if rehash, err := engine.NeedsRehash(first); err != nil || rehash {
				t.Fatalf("current dummy policy: rehash=%t error=%v", rehash, err)
			}
			assertDummyPermitsDrained(t, engine, 1, policy.MemoryKiB)

			engine.kernel = func(password, salt []byte, iterations, memory uint32, parallelism uint8, keyBytes uint32) []byte {
				calls++
				stats := engine.Stats()
				if string(password) != "unknown account password" || !bytes.Equal(salt, stored.salt) ||
					iterations != policy.Iterations || memory != policy.MemoryKiB || parallelism != policy.Parallelism || keyBytes != 32 ||
					stats.Active != 1 || stats.MemoryKiB != policy.MemoryKiB {
					t.Errorf("dummy verification changed kernel inputs or bypassed admission: %+v", stats)
				}
				wrong := bytes.Clone(stored.key)
				wrong[0] ^= 1
				return wrong
			}
			if match, err := engine.VerifyPassword(t.Context(), first, "unknown account password"); err != nil || match || calls != 1 {
				t.Fatalf("dummy verification: match=%t error=%v calls=%d", match, err, calls)
			}
			assertDummyPermitsDrained(t, engine, 1, policy.MemoryKiB)
		})
	}
}

func TestEngineDummyPreparationRejectsCancelledAndStoppedWork(t *testing.T) {
	for _, stopped := range []bool{false, true} {
		t.Run(fmt.Sprint(stopped), func(t *testing.T) {
			engine := testEngine(t, smallPasswordConfig())
			engine.dummyRandom = dummyReaderFunc(func([]byte) (int, error) {
				t.Fatal("rejected dummy preparation read entropy")
				return 0, io.EOF
			})
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			want := context.Canceled
			if stopped {
				engine.Stop()
				want = domain.ErrCredentialBusy
			} else {
				cancel()
			}
			encoded, err := engine.DummyHash(ctx)
			if encoded != "" || !errors.Is(err, want) {
				t.Fatalf("rejected preparation: encoded=%t error=%v", encoded != "", err)
			}
			assertDummyPermitsDrained(t, engine, 0, 0)
		})
	}
}

func TestEngineDummyPreparationPreservesEntropyFailureAndReleasesCapacity(t *testing.T) {
	for _, available := range []int{0, 15, 16, 47} {
		t.Run(fmt.Sprint(available), func(t *testing.T) {
			engine := testEngine(t, smallPasswordConfig())
			engine.dummyRandom = bytes.NewReader(make([]byte, available))
			encoded, err := engine.DummyHash(t.Context())
			if encoded != "" || (!errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF)) {
				t.Fatalf("partial entropy produced dummy or lost error: encoded=%t error=%v", encoded != "", err)
			}
			assertDummyPermitsDrained(t, engine, 1, 32)
		})
	}
}

func TestEngineDummyPreparationQueuesBehindSharedMemoryAndHonorsCancellation(t *testing.T) {
	engine := testEngine(t, smallPasswordConfig())
	release, err := engine.acquire(t.Context(), 64)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	joined := make(chan struct{})
	go func() {
		defer close(joined)
		_, err := engine.DummyHash(ctx)
		done <- err
	}()
	t.Cleanup(func() { cancel(); <-joined })
	waitQueued(t, engine, 1)
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("queued dummy error=%v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("queued dummy did not cancel")
	}
	release()
	assertDummyPermitsDrained(t, engine, 1, 64)
}

func TestEngineDummyPreparationJoinsEntropyBeforeDiscardingCancelledOrStoppedResult(t *testing.T) {
	for _, stopped := range []bool{false, true} {
		t.Run(fmt.Sprint(stopped), func(t *testing.T) {
			engine := testEngine(t, smallPasswordConfig())
			started, unblock, joined := make(chan struct{}), make(chan struct{}), make(chan struct{})
			var signal, release sync.Once
			engine.dummyRandom = dummyReaderFunc(func(p []byte) (int, error) {
				signal.Do(func() { close(started) })
				<-unblock
				return copy(p, bytes.Repeat([]byte{1}, len(p))), nil
			})
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			done := make(chan error, 1)
			go func() {
				defer close(joined)
				encoded, err := engine.DummyHash(ctx)
				if encoded != "" {
					err = errors.New("cancelled preparation returned a verifier")
				}
				done <- err
			}()
			t.Cleanup(func() { release.Do(func() { close(unblock) }); <-joined })
			select {
			case <-started:
			case <-time.After(5 * time.Second):
				t.Fatal("dummy preparation did not start entropy read")
			}
			want := context.Canceled
			if stopped {
				engine.Stop()
				want = domain.ErrCredentialBusy
			} else {
				cancel()
			}
			if stats := engine.Stats(); stats.Active != 1 || stats.MemoryKiB != 32 {
				t.Fatalf("dummy released capacity before entropy joined: %+v", stats)
			}
			closed := make(chan struct{})
			go func() { engine.Close(); close(closed) }()
			t.Cleanup(func() { release.Do(func() { close(unblock) }); <-closed })
			select {
			case <-closed:
				t.Fatal("Close returned while dummy entropy was still running")
			case <-done:
				t.Fatal("dummy returned while entropy was still running")
			case <-time.After(20 * time.Millisecond):
			}
			release.Do(func() { close(unblock) })
			<-joined
			<-closed
			if err := <-done; !errors.Is(err, want) {
				t.Fatalf("dummy result did not preserve cancellation/shutdown: %v", err)
			}
			assertDummyPermitsDrained(t, engine, 1, 32)
		})
	}
}

type dummyReaderFunc func([]byte) (int, error)

func (read dummyReaderFunc) Read(p []byte) (int, error) { return read(p) }

func assertDummyPermitsDrained(t *testing.T, engine *Engine, peakActive int, peakMemory uint32) {
	t.Helper()
	if stats := engine.Stats(); stats.Active != 0 || stats.MemoryKiB != 0 || stats.Queued != 0 ||
		stats.PeakActive != peakActive || stats.PeakMemoryKiB != peakMemory {
		t.Fatalf("dummy admission leaked capacity or used wrong weight: %+v", stats)
	}
}
