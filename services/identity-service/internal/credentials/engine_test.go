package credentials

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/crypto/argon2"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

func testEngine(t *testing.T, config PasswordConfig) *Engine {
	t.Helper()
	engine, err := NewEngine(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(engine.Close)
	return engine
}

func smallPasswordConfig() PasswordConfig {
	return PasswordConfig{Policy: PasswordPolicy{MemoryKiB: 32, Iterations: 1, Parallelism: 2}, MemoryBudgetKiB: 64, MaxConcurrent: 2}
}

func encodedTestPassword(memory, iterations uint32, parallelism uint8) string {
	salt := []byte("0123456789abcdef")
	key := argon2.IDKey([]byte("correct password value"), salt, iterations, memory, parallelism, 32)
	return fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s", memory, iterations, parallelism, base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key))
}

func TestEngineVerifiesStoredParametersAndReportsRehash(t *testing.T) {
	engine := testEngine(t, smallPasswordConfig())
	// A non-lane-aligned m must reach Argon2 unchanged: m is part of its input.
	for _, memory := range []uint32{17, 32, 48} {
		t.Run(fmt.Sprint(memory), func(t *testing.T) {
			encoded := encodedTestPassword(memory, 1, 2)
			ok, err := engine.VerifyPassword(context.Background(), encoded, "correct password value")
			if err != nil || !ok {
				t.Fatalf("stored parameters: match=%t error=%v", ok, err)
			}
			ok, err = engine.VerifyPassword(context.Background(), encoded, "wrong password value")
			if err != nil || ok {
				t.Fatalf("wrong password: match=%t error=%v", ok, err)
			}
			rehash, err := engine.NeedsRehash(encoded)
			if err != nil || rehash != (memory != 32) {
				t.Fatalf("NeedsRehash=%t error=%v", rehash, err)
			}
		})
	}
	for _, encoded := range []string{encodedTestPassword(32, 2, 2), encodedTestPassword(32, 1, 1)} {
		if rehash, err := engine.NeedsRehash(encoded); err != nil || !rehash {
			t.Fatalf("changed iterations/parallelism: rehash=%t error=%v", rehash, err)
		}
	}
}

func TestEngineRejectsNoncanonicalOrUnboundedHashBeforeKernel(t *testing.T) {
	engine := testEngine(t, smallPasswordConfig())
	engine.kernel = func([]byte, []byte, uint32, uint32, uint8, uint32) []byte {
		t.Fatal("invalid encoding reached kernel")
		return nil
	}
	valid := encodedTestPassword(32, 1, 2)
	parts := strings.Split(valid, "$")
	for _, replacement := range []string{
		"m=0,t=1,p=2", "m=15,t=1,p=2", "m=1048577,t=1,p=2", "m=4294967296,t=1,p=2",
		"m=32,t=0,p=2", "m=32,t=11,p=2", "m=32,t=1,p=0", "m=32,t=1,p=17",
		"m=+32,t=1,p=2", "m=032,t=1,p=2", "m=32,t=01,p=2", "m=32,t=1,p=02",
		"t=1,m=32,p=2", "m=32,t=1,p=2,p=2", "m=32,t=1,p=2trailing", "m=32,t=1,p=2 ",
	} {
		candidate := strings.Replace(valid, parts[3], replacement, 1)
		assertInvalidStoredHash(t, engine, candidate)
	}
	for _, candidate := range []string{
		"", strings.Repeat("x", 257), valid + "$trailing", valid + "\n",
		strings.Replace(valid, "argon2id", "argon2i", 1),
		strings.Replace(valid, "v=19", "v=19junk", 1),
		strings.Replace(valid, "v=19", "v=019", 1),
		strings.Replace(valid, "v=19", "v=16", 1),
		strings.Replace(valid, parts[4], parts[4]+"==", 1),
		strings.Replace(valid, parts[4], parts[4][:len(parts[4])-1]+"B", 1),
		strings.Replace(valid, parts[5], parts[5]+"=", 1),
		strings.Replace(valid, parts[5], parts[5][:len(parts[5])-1]+"/", 1),
		strings.Replace(valid, parts[4], base64.RawStdEncoding.EncodeToString(make([]byte, 15)), 1),
		strings.Replace(valid, parts[5], base64.RawStdEncoding.EncodeToString(make([]byte, 31)), 1),
	} {
		assertInvalidStoredHash(t, engine, candidate)
	}
}

func assertInvalidStoredHash(t *testing.T, engine *Engine, encoded string) {
	t.Helper()
	if match, err := engine.VerifyPassword(context.Background(), encoded, "password value"); match || !errors.Is(err, ErrInvalidPasswordEncoding) {
		t.Fatalf("VerifyPassword(%q): match=%t error=%v", encoded, match, err)
	}
	if rehash, err := engine.NeedsRehash(encoded); rehash || !errors.Is(err, ErrInvalidPasswordEncoding) {
		t.Fatalf("NeedsRehash(%q): rehash=%t error=%v", encoded, rehash, err)
	}
}

func TestEngineHashesCurrentPolicyAndKeepsInputErrorsSeparateFromBusy(t *testing.T) {
	engine := testEngine(t, smallPasswordConfig())
	first, err := engine.HashPassword(context.Background(), "correct password value")
	if err != nil {
		t.Fatal(err)
	}
	second, err := engine.HashPassword(context.Background(), "correct password value")
	if err != nil || first == second || !strings.HasPrefix(first, "$argon2id$v=19$m=32,t=1,p=2$") {
		t.Fatalf("current policy/random salt: equal=%t error=%v", first == second, err)
	}
	if match, err := engine.VerifyPassword(context.Background(), first, "correct password value"); !match || err != nil {
		t.Fatalf("round trip: match=%t error=%v", match, err)
	}
	for _, password := range []string{"short", strings.Repeat("a", 1025)} {
		if _, err := engine.HashPassword(context.Background(), password); !errors.Is(err, domain.ErrInvalidArgument) {
			t.Fatalf("password policy error=%v", err)
		}
	}
	if match, err := engine.VerifyPassword(context.Background(), encodedTestPassword(96, 1, 2), "correct password value"); match || !errors.Is(err, domain.ErrCredentialBusy) {
		t.Fatalf("valid stored cost above budget: match=%t error=%v", match, err)
	}
}

func TestEngineRejectsInvalidConfiguration(t *testing.T) {
	for _, config := range []PasswordConfig{
		{},
		{Policy: PasswordPolicy{MemoryKiB: 15, Iterations: 1, Parallelism: 2}, MemoryBudgetKiB: 64, MaxConcurrent: 2},
		{Policy: PasswordPolicy{MemoryKiB: 32, Iterations: 11, Parallelism: 2}, MemoryBudgetKiB: 64, MaxConcurrent: 2},
		{Policy: PasswordPolicy{MemoryKiB: 32, Iterations: 1, Parallelism: 17}, MemoryBudgetKiB: 64, MaxConcurrent: 2},
		{Policy: PasswordPolicy{MemoryKiB: 32, Iterations: 1, Parallelism: 2}, MemoryBudgetKiB: 16, MaxConcurrent: 2},
		{Policy: PasswordPolicy{MemoryKiB: 32, Iterations: 1, Parallelism: 2}, MemoryBudgetKiB: 4194305, MaxConcurrent: 2},
		{Policy: PasswordPolicy{MemoryKiB: 32, Iterations: 1, Parallelism: 2}, MemoryBudgetKiB: 64, MaxConcurrent: 65},
	} {
		engine, err := NewEngine(config)
		if err == nil {
			engine.Close()
			t.Fatalf("accepted config %+v", config)
		}
	}
}

func TestEngineJointWeightedAdmissionIsFIFO(t *testing.T) {
	engine := testEngine(t, smallPasswordConfig())
	release, err := engine.acquire(context.Background(), 32)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	large := acquireAsync(engine, context.Background(), 48)
	waitQueued(t, engine, 1)
	small := acquireAsync(engine, context.Background(), 16)
	waitQueued(t, engine, 2)
	select {
	case <-small:
		t.Fatal("small operation bypassed FIFO head")
	default:
	}
	release()
	largePermit, smallPermit := awaitPermit(t, large), awaitPermit(t, small)
	if largePermit.err != nil || smallPermit.err != nil {
		t.Fatalf("admit queued work: %v %v", largePermit.err, smallPermit.err)
	}
	defer largePermit.release()
	defer smallPermit.release()
	if stats := engine.Stats(); stats.Active != 2 || stats.MemoryKiB != 64 || stats.PeakMemoryKiB > 64 || stats.PeakActive > 2 {
		t.Fatalf("joint admission: %+v", stats)
	}
	// Both capacities are charged atomically. Even an 8 KiB job needs a slot.
	third := acquireAsync(engine, context.Background(), 8)
	waitQueued(t, engine, 1)
	largePermit.release()
	last := awaitPermit(t, third)
	if last.err != nil {
		t.Fatal(last.err)
	}
	last.release()
}

type permitResult struct {
	release func()
	err     error
}

func acquireAsync(engine *Engine, ctx context.Context, memory uint32) <-chan permitResult {
	done := make(chan permitResult, 1)
	go func() {
		release, err := engine.acquire(ctx, memory)
		done <- permitResult{release: release, err: err}
	}()
	return done
}

func awaitPermit(t *testing.T, done <-chan permitResult) permitResult {
	t.Helper()
	select {
	case result := <-done:
		return result
	case <-time.After(5 * time.Second):
		t.Fatal("resource admission did not finish")
		return permitResult{}
	}
}

func waitQueued(t *testing.T, engine *Engine, count int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if engine.Stats().Queued == count {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("queued=%d, want %d", engine.Stats().Queued, count)
}

func TestEngineQueueIsBoundedAndCancellationRemovesWaiter(t *testing.T) {
	engine := testEngine(t, smallPasswordConfig())
	release, err := engine.acquire(context.Background(), 64)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	queued := make([]<-chan permitResult, 32)
	for index := range queued {
		queued[index] = acquireAsync(engine, ctx, 32)
		waitQueued(t, engine, index+1)
	}
	if _, err := engine.acquire(context.Background(), 32); !errors.Is(err, domain.ErrCredentialBusy) {
		t.Fatalf("full queue error=%v", err)
	}
	cancel()
	for _, done := range queued {
		if result := awaitPermit(t, done); !errors.Is(result.err, context.Canceled) {
			t.Fatalf("cancelled waiter error=%v", result.err)
		}
	}
	waitQueued(t, engine, 0)
	release()
	if _, err := engine.HashPassword(context.Background(), "normal password after pressure"); err != nil {
		t.Fatalf("capacity did not recover: %v", err)
	}
}

func TestEngineWaitUsesOneBoundedDeadline(t *testing.T) {
	engine := testEngine(t, smallPasswordConfig())
	release, err := engine.acquire(context.Background(), 64)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := engine.acquire(ctx, 32); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("request deadline error=%v", err)
	}
	started := time.Now()
	if _, err := engine.acquire(context.Background(), 32); !errors.Is(err, domain.ErrCredentialBusy) {
		t.Fatalf("resource wait expiry error=%v", err)
	}
	if elapsed := time.Since(started); elapsed < 1900*time.Millisecond || elapsed > 4*time.Second {
		t.Fatalf("resource wait elapsed=%s", elapsed)
	}
	waitQueued(t, engine, 0)
}

func TestEngineRunningCancellationAndCloseJoinKernelBeforeReleasingCapacity(t *testing.T) {
	engine := testEngine(t, smallPasswordConfig())
	started, finish := make(chan struct{}), make(chan struct{})
	var finishOnce sync.Once
	finishKernel := func() { finishOnce.Do(func() { close(finish) }) }
	t.Cleanup(finishKernel)
	var calls atomic.Int32
	engine.kernel = func([]byte, []byte, uint32, uint32, uint8, uint32) []byte {
		calls.Add(1)
		close(started)
		<-finish
		return make([]byte, 32)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() {
		_, err := engine.HashPassword(ctx, "correct password value")
		result <- err
	}()
	<-started
	cancel()
	if stats := engine.Stats(); stats.Active != 1 || stats.MemoryKiB != 32 {
		t.Fatalf("running cancellation released capacity: %+v", stats)
	}
	closed := make(chan struct{})
	go func() { engine.Close(); close(closed) }()
	select {
	case <-result:
		t.Fatal("running cancellation returned before KDF joined")
	case <-closed:
		t.Fatal("Close returned before KDF joined")
	case <-time.After(20 * time.Millisecond):
	}
	finishKernel()
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled result error=%v", err)
	}
	<-closed
	if _, err := engine.HashPassword(context.Background(), "correct password value"); !errors.Is(err, domain.ErrCredentialBusy) {
		t.Fatalf("closed engine error=%v", err)
	}
	if stats := engine.Stats(); stats.Active != 0 || stats.MemoryKiB != 0 || stats.Queued != 0 || calls.Load() != 1 {
		t.Fatalf("engine did not drain: %+v calls=%d", stats, calls.Load())
	}
}

func TestEngineCloseRejectsQueuedWorkAndJoinsAdmittedWork(t *testing.T) {
	engine := testEngine(t, smallPasswordConfig())
	release, err := engine.acquire(context.Background(), 64)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	queued := acquireAsync(engine, context.Background(), 32)
	waitQueued(t, engine, 1)
	closed := make(chan struct{})
	go func() { engine.Close(); close(closed) }()
	if result := awaitPermit(t, queued); !errors.Is(result.err, domain.ErrCredentialBusy) {
		t.Fatalf("shutdown waiter error=%v", result.err)
	}
	select {
	case <-closed:
		t.Fatal("Close returned with admitted work outstanding")
	default:
	}
	release()
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("Close did not join admitted work")
	}
	if stats := engine.Stats(); stats.Active != 0 || stats.MemoryKiB != 0 || stats.Queued != 0 {
		t.Fatalf("shutdown retained resources: %+v", stats)
	}
}

func TestEngineCancellationRacingAdmissionNeverLeaksPermits(t *testing.T) {
	engine := testEngine(t, smallPasswordConfig())
	for range 100 {
		release, err := engine.acquire(context.Background(), 64)
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		queued := acquireAsync(engine, ctx, 32)
		waitQueued(t, engine, 1)
		cancelled := make(chan struct{})
		go func() { cancel(); close(cancelled) }()
		release()
		result := awaitPermit(t, queued)
		<-cancelled
		if result.err == nil {
			result.release()
		} else if !errors.Is(result.err, context.Canceled) {
			t.Fatalf("raced cancellation error=%v", result.err)
		}
		if stats := engine.Stats(); stats.Active != 0 || stats.MemoryKiB != 0 || stats.Queued != 0 {
			t.Fatalf("cancellation leaked capacity: %+v", stats)
		}
	}
}

func TestEngineCancelledFIFOHeadUnblocksSmallerFollower(t *testing.T) {
	engine := testEngine(t, smallPasswordConfig())
	release, err := engine.acquire(context.Background(), 32)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	head := acquireAsync(engine, ctx, 48)
	waitQueued(t, engine, 1)
	follower := acquireAsync(engine, context.Background(), 16)
	waitQueued(t, engine, 2)
	cancel()
	if result := awaitPermit(t, head); !errors.Is(result.err, context.Canceled) {
		t.Fatalf("head cancellation=%v", result.err)
	}
	result := awaitPermit(t, follower)
	if result.err != nil {
		t.Fatalf("follower stayed blocked after head cancellation: %v", result.err)
	}
	defer result.release()
	if stats := engine.Stats(); stats.Active != 2 || stats.MemoryKiB != 48 {
		t.Fatalf("follower did not share remaining capacity: %+v", stats)
	}
}

func TestEngineOverBudgetStoredHashNeverStartsKernel(t *testing.T) {
	engine := testEngine(t, smallPasswordConfig())
	var calls atomic.Int32
	engine.kernel = func([]byte, []byte, uint32, uint32, uint8, uint32) []byte {
		calls.Add(1)
		return make([]byte, 32)
	}
	match, err := engine.VerifyPassword(context.Background(), encodedTestPassword(96, 1, 2), "correct password value")
	var cause *PasswordAdmissionError
	if match || !errors.Is(err, domain.ErrCredentialBusy) || !errors.As(err, &cause) || cause.Reason != "weight_exceeds_budget" || calls.Load() != 0 {
		t.Fatalf("over-budget rejection: match=%t error=%v cause=%+v calls=%d", match, err, cause, calls.Load())
	}
	if stats := engine.Stats(); stats.Active != 0 || stats.Queued != 0 || stats.OverBudget != 1 {
		t.Fatalf("over-budget operation acquired resources: %+v", stats)
	}
}

func TestEngineStopDiscardsRunningResultAndCloseJoinsWithoutCallerCancellation(t *testing.T) {
	engine := testEngine(t, smallPasswordConfig())
	started, finish := make(chan struct{}), make(chan struct{})
	var finishOnce sync.Once
	finishKernel := func() { finishOnce.Do(func() { close(finish) }) }
	t.Cleanup(finishKernel)
	engine.kernel = func([]byte, []byte, uint32, uint32, uint8, uint32) []byte {
		close(started)
		<-finish
		return make([]byte, 32)
	}
	type hashResult struct {
		hash string
		err  error
	}
	done := make(chan hashResult, 1)
	go func() {
		hash, err := engine.HashPassword(context.Background(), "correct password value")
		done <- hashResult{hash, err}
	}()
	<-started
	engine.Stop()
	if stats := engine.Stats(); stats.Active != 1 || stats.MemoryKiB != 32 {
		t.Fatalf("Stop released running capacity: %+v", stats)
	}
	closed := make(chan struct{})
	go func() { engine.Close(); close(closed) }()
	select {
	case <-closed:
		t.Fatal("Close did not join running work")
	case <-done:
		t.Fatal("Stop returned the running hash before its kernel completed")
	case <-time.After(20 * time.Millisecond):
	}
	finishKernel()
	result := <-done
	if result.hash != "" || !errors.Is(result.err, domain.ErrCredentialBusy) {
		t.Fatalf("shutdown delivered a hash: hash=%q error=%v", result.hash, result.err)
	}
	<-closed
}
