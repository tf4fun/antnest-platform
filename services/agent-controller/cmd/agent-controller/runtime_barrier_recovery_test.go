package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/stretchr/testify/require"
)

func TestControllerRuntimeBarrierRecoveryOwnsIndependentWorkersAndServeUntilActualJoin(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		fixture := newControllerOwnershipFixture(true,
			"execution_publication", "runtime_observation", "identity_revocation",
			"runtime_barrier_recovery_observation", "runtime_barrier_recovery_start")
		fixture.server.holdReturn = true
		defer fixture.cleanup(t)
		fixture.start()
		awaitControllerOwnership(t, fixture.server.started, "HTTP Serve did not enter")
		for _, worker := range fixture.workers {
			awaitControllerOwnership(t, worker.started, worker.name+" was blocked behind another worker")
			require.True(t, worker.runContext() == fixture.workers[0].runContext(), "all workers share the same owned cancellation context")
			require.True(t, worker.runContext() != fixture.ctx, "workers receive a derived context rather than the caller's context")
			require.NoError(t, worker.runContext().Err())
		}
		// Publication remains inside its original long-running callback throughout
		// startup. Both recovery workers must already have entered independently.
		fixture.assertStillOwned(t)
		fixture.cancel()
		for _, worker := range fixture.workers {
			awaitControllerOwnership(t, worker.cancelled, worker.name+" did not receive cancellation")
		}
		awaitControllerOwnership(t, fixture.server.shutdownStarted, "parent cancellation did not shut down HTTP")
		awaitControllerOwnership(t, fixture.server.exitRequested, "HTTP shutdown did not reach the actual Serve callback")
		fixture.assertStillOwned(t)

		for _, worker := range fixture.workers[:3] {
			worker.release()
			awaitControllerOwnership(t, worker.returned, worker.name+" did not actually return")
		}
		fixture.workers[3].release()
		awaitControllerOwnership(t, fixture.workers[3].returned, "observation callback did not actually return")
		fixture.assertStillOwned(t)
		fixture.workers[4].release()
		awaitControllerOwnership(t, fixture.workers[4].returned, "pending-start callback did not actually return")
		fixture.assertStillOwned(t)
		fixture.server.release()
		awaitControllerOwnership(t, fixture.server.returned, "the original Serve callback did not actually return")
		require.NoError(t, fixture.join(t))
		fixture.assertClosedAfterActualJoins(t)
	})
}

func TestControllerRuntimeBarrierRecoveryServeFailurePreservesCleanupErrorsAndJoinsEveryWorker(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		fixture := newControllerOwnershipFixture(true,
			"execution_publication", "runtime_observation", "identity_revocation",
			"runtime_barrier_recovery_observation", "runtime_barrier_recovery_start")
		serveFailure := errors.New("owned HTTP Serve failure")
		shutdownFailure := errors.New("owned HTTP Shutdown failure")
		closeFailure := errors.New("owned HTTP Close failure")
		fixture.server.serveError = serveFailure
		fixture.server.shutdownError = shutdownFailure
		fixture.server.closeError = closeFailure
		defer fixture.cleanup(t)
		fixture.start()
		awaitControllerOwnership(t, fixture.server.started, "HTTP Serve did not enter")
		for _, worker := range fixture.workers {
			awaitControllerOwnership(t, worker.started, worker.name+" did not enter")
		}
		fixture.server.requestExit()
		awaitControllerOwnership(t, fixture.server.returned, "the failing Serve callback did not return")
		for _, worker := range fixture.workers {
			awaitControllerOwnership(t, worker.cancelled, "Serve failure did not cancel "+worker.name)
		}
		awaitControllerOwnership(t, fixture.server.closeCalled, "a failed Shutdown must still attempt Close")
		fixture.assertStillOwned(t)
		// A failure from the first cleanup operation cannot skip any later owner.
		for _, worker := range fixture.workers {
			worker.release()
			awaitControllerOwnership(t, worker.returned, worker.name+" was not joined after HTTP cleanup failed")
		}
		err := fixture.join(t)
		require.ErrorIs(t, err, serveFailure)
		require.ErrorIs(t, err, shutdownFailure)
		require.ErrorIs(t, err, closeFailure)
		require.NoError(t, fixture.ctx.Err(), "Serve failure cancels the owned child context, not the caller's context")
		fixture.assertClosedAfterActualJoins(t)
		state := fixture.server.snapshot()
		require.Equal(t, 1, state.shutdownCalls)
		require.Equal(t, 1, state.closeCalls)
	})
}

func TestControllerRuntimeBarrierRecoveryShutdownDeadlineCannotDetachWorkersOrServe(t *testing.T) {
	for _, waitForHTTPDeadline := range []bool{false, true} {
		name := "HTTP succeeds while a worker remains held"
		if waitForHTTPDeadline {
			name = "HTTP times out and its actual Serve return remains held"
		}
		t.Run(name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				fixture := newControllerOwnershipFixture(true,
					"runtime_barrier_recovery_observation", "runtime_barrier_recovery_start")
				fixture.server.waitForDeadline = waitForHTTPDeadline
				fixture.server.holdReturn = waitForHTTPDeadline
				defer fixture.cleanup(t)
				fixture.start()
				awaitControllerOwnership(t, fixture.server.started, "HTTP Serve did not enter")
				for _, worker := range fixture.workers {
					awaitControllerOwnership(t, worker.started, worker.name+" did not enter")
				}
				fixture.cancel()
				for _, worker := range fixture.workers {
					awaitControllerOwnership(t, worker.cancelled, worker.name+" did not observe parent cancellation")
				}
				awaitControllerOwnership(t, fixture.server.shutdownStarted, "HTTP Shutdown did not enter")
				shutdownContext := fixture.server.snapshot().shutdownContext
				require.NotNil(t, shutdownContext)
				_, bounded := shutdownContext.Deadline()
				require.True(t, bounded, "shutdown must have an independent bounded context")
				// This receipt is the actual context deadline, not a fixed sleep used
				// as evidence that cleanup or a dependency has completed.
				awaitControllerOwnership(t, shutdownContext.Done(), "the shutdown budget never expired")
				require.ErrorIs(t, shutdownContext.Err(), context.DeadlineExceeded)
				fixture.assertStillOwned(t)
				if waitForHTTPDeadline {
					awaitControllerOwnership(t, fixture.server.closeCalled, "timed-out HTTP Shutdown did not attempt Close")
					awaitControllerOwnership(t, fixture.server.exitRequested, "Close did not reach the original Serve callback")
					fixture.server.release()
					awaitControllerOwnership(t, fixture.server.returned, "released Serve did not actually return")
					fixture.assertStillOwned(t)
				} else {
					awaitControllerOwnership(t, fixture.server.returned, "successful HTTP Shutdown did not join Serve")
				}
				fixture.workers[0].release()
				awaitControllerOwnership(t, fixture.workers[0].returned, "observation callback did not actually return")
				fixture.assertStillOwned(t)
				fixture.workers[1].release()
				awaitControllerOwnership(t, fixture.workers[1].returned, "pending-start callback did not actually return")
				require.ErrorIs(t, fixture.join(t), context.DeadlineExceeded,
					"actual joins after the budget do not erase the shutdown deadline failure")
				fixture.assertClosedAfterActualJoins(t)
			})
		})
	}
}

func TestControllerRuntimeBarrierRecoverySupportsZeroOrOneBackgroundWorker(t *testing.T) {
	for _, count := range []int{0, 1} {
		name := "zero workers"
		if count == 1 {
			name = "one worker"
		}
		t.Run(name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				var names []string
				if count == 1 {
					names = []string{"runtime_barrier_recovery_start"}
				}
				fixture := newControllerOwnershipFixture(false, names...)
				defer fixture.cleanup(t)
				fixture.start()
				awaitControllerOwnership(t, fixture.server.started, "HTTP Serve did not enter")
				for _, worker := range fixture.workers {
					awaitControllerOwnership(t, worker.started, "the only worker did not enter")
				}
				fixture.cancel()
				require.NoError(t, fixture.join(t))
				fixture.assertClosedAfterActualJoins(t)
				require.Equal(t, 1, fixture.server.snapshot().shutdownCalls)
			})
		})
	}
}

func TestControllerRuntimeBarrierRecoveryPreCancellationDispatchesNoBackgroundBusiness(t *testing.T) {
	for _, closeFailure := range []error{nil, errors.New("owned listener Close failure")} {
		name := "listener closes successfully"
		if closeFailure != nil {
			name = "listener Close failure is preserved"
		}
		t.Run(name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				fixture := newControllerOwnershipFixture(false,
					"execution_publication", "runtime_barrier_recovery_observation", "runtime_barrier_recovery_start")
				fixture.listener.closeError = closeFailure
				defer fixture.cleanup(t)
				fixture.cancel()
				fixture.start()
				err := fixture.join(t)
				if closeFailure != nil {
					require.ErrorIs(t, err, closeFailure)
				} else {
					require.NoError(t, err)
				}
				synctest.Wait()
				require.Zero(t, fixture.server.snapshot().serveCalls, "pre-cancellation cannot dispatch Serve")
				for _, worker := range fixture.workers {
					require.Zero(t, worker.callCount(), "pre-cancellation cannot invoke "+worker.name)
				}
				require.Equal(t, 1, fixture.listener.closeCount(), "the helper must actually close its undispatched owned listener once")
				fixture.assertClosedAfterActualJoins(t)
			})
		})
	}
}

type controllerOwnershipFixture struct {
	ctx          context.Context
	cancel       context.CancelFunc
	server       *controllerOwnershipServer
	listener     *controllerOwnershipListener
	workers      []*controllerOwnershipWorker
	mu           sync.Mutex
	closed       map[string]int
	earlyClosers []string
	done         chan struct{}
	err          error
}

func newControllerOwnershipFixture(held bool, names ...string) *controllerOwnershipFixture {
	ctx, cancel := context.WithCancel(context.Background())
	fixture := &controllerOwnershipFixture{ctx: ctx, cancel: cancel,
		server: newControllerOwnershipServer(), listener: &controllerOwnershipListener{}, closed: make(map[string]int)}
	for _, name := range names {
		fixture.workers = append(fixture.workers, &controllerOwnershipWorker{name: name, held: held,
			started: make(chan struct{}), cancelled: make(chan struct{}), released: make(chan struct{}), returned: make(chan struct{})})
	}
	return fixture
}

func (fixture *controllerOwnershipFixture) start() {
	var workers []controllerBackgroundWorker
	for _, worker := range fixture.workers {
		workers = append(workers, controllerBackgroundWorker{name: worker.name, run: worker.run})
	}
	fixture.done = make(chan struct{})
	go func() {
		defer close(fixture.done)
		// Model main's dependency owners without constructing Temporal or PG.
		// Their closes are observed only after serveController actually returns.
		defer fixture.closeDependency("postgres")
		defer fixture.closeDependency("temporal")
		fixture.err = serveController(fixture.ctx, fixture.server, fixture.listener, 2*time.Second, workers...)
	}()
}

func (fixture *controllerOwnershipFixture) closeDependency(name string) {
	var unjoined []string
	if fixture.server.snapshot().serveCalls != 0 && !controllerOwnershipClosed(fixture.server.returned) {
		unjoined = append(unjoined, "HTTP Serve")
	}
	for _, worker := range fixture.workers {
		if worker.callCount() != 0 && !controllerOwnershipClosed(worker.returned) {
			unjoined = append(unjoined, worker.name)
		}
	}
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	fixture.closed[name]++
	for _, owner := range unjoined {
		fixture.earlyClosers = append(fixture.earlyClosers, name+" closed before "+owner)
	}
}

func (fixture *controllerOwnershipFixture) assertStillOwned(t *testing.T) {
	t.Helper()
	synctest.Wait()
	require.False(t, controllerOwnershipClosed(fixture.done), "serveController detached an actual callback")
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	require.Empty(t, fixture.closed, "outer Temporal/PG close cannot run before all callbacks settle")
}

func (fixture *controllerOwnershipFixture) assertClosedAfterActualJoins(t *testing.T) {
	t.Helper()
	synctest.Wait()
	if fixture.server.snapshot().serveCalls != 0 {
		require.True(t, controllerOwnershipClosed(fixture.server.returned), "the original Serve call must actually join")
	}
	for _, worker := range fixture.workers {
		if worker.callCount() != 0 {
			require.Equal(t, 1, worker.callCount(), "one callback owns "+worker.name)
			require.True(t, controllerOwnershipClosed(worker.returned), "worker did not actually join: "+worker.name)
		}
	}
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	require.Equal(t, map[string]int{"temporal": 1, "postgres": 1}, fixture.closed)
	require.Empty(t, fixture.earlyClosers)
}

func (fixture *controllerOwnershipFixture) join(t *testing.T) error {
	t.Helper()
	awaitControllerOwnership(t, fixture.done, "serveController did not join after releasing its owners")
	return fixture.err
}

func (fixture *controllerOwnershipFixture) cleanup(t *testing.T) {
	t.Helper()
	fixture.cancel()
	for _, worker := range fixture.workers {
		worker.release()
	}
	fixture.server.requestExit()
	fixture.server.release()
	// Fallback cleanup is after the behavioral assertions. Inspect each owned
	// call independently, so one failed join cannot skip another owner.
	if fixture.done != nil {
		cleanupControllerOwnership(t, fixture.done, "serveController")
	}
	if fixture.server.snapshot().serveCalls != 0 {
		cleanupControllerOwnership(t, fixture.server.returned, "HTTP Serve")
	}
	for _, worker := range fixture.workers {
		if worker.callCount() != 0 {
			cleanupControllerOwnership(t, worker.returned, worker.name)
		}
	}
}

type controllerOwnershipWorker struct {
	name                                   string
	held                                   bool
	started, cancelled, released, returned chan struct{}
	startOnce, cancelOnce, releaseOnce     sync.Once
	returnOnce                             sync.Once
	mu                                     sync.Mutex
	calls                                  int
	ctx                                    context.Context
}

func (worker *controllerOwnershipWorker) run(ctx context.Context) {
	worker.mu.Lock()
	worker.calls++
	worker.ctx = ctx
	worker.mu.Unlock()
	defer worker.returnOnce.Do(func() { close(worker.returned) })
	worker.startOnce.Do(func() { close(worker.started) })
	<-ctx.Done()
	worker.cancelOnce.Do(func() { close(worker.cancelled) })
	if worker.held {
		<-worker.released
	}
}

func (worker *controllerOwnershipWorker) release() {
	worker.releaseOnce.Do(func() { close(worker.released) })
}

func (worker *controllerOwnershipWorker) callCount() int {
	worker.mu.Lock()
	defer worker.mu.Unlock()
	return worker.calls
}

func (worker *controllerOwnershipWorker) runContext() context.Context {
	worker.mu.Lock()
	defer worker.mu.Unlock()
	return worker.ctx
}

type controllerOwnershipServer struct {
	serveError, shutdownError, closeError        error
	holdReturn, waitForDeadline                  bool
	started, shutdownStarted, closeCalled        chan struct{}
	stop, exitRequested, released, returned      chan struct{}
	startOnce, shutdownOnce, closeOnce, stopOnce sync.Once
	exitOnce, releaseOnce, returnOnce            sync.Once
	mu                                           sync.Mutex
	state                                        controllerOwnershipServerState
}

type controllerOwnershipServerState struct {
	serveCalls, shutdownCalls, closeCalls int
	shutdownContext                       context.Context
}

func newControllerOwnershipServer() *controllerOwnershipServer {
	return &controllerOwnershipServer{serveError: http.ErrServerClosed,
		started: make(chan struct{}), shutdownStarted: make(chan struct{}), closeCalled: make(chan struct{}),
		stop: make(chan struct{}), exitRequested: make(chan struct{}), released: make(chan struct{}), returned: make(chan struct{})}
}

func (server *controllerOwnershipServer) Serve(net.Listener) error {
	server.mu.Lock()
	server.state.serveCalls++
	server.mu.Unlock()
	defer server.returnOnce.Do(func() { close(server.returned) })
	server.startOnce.Do(func() { close(server.started) })
	<-server.stop
	server.exitOnce.Do(func() { close(server.exitRequested) })
	if server.holdReturn {
		<-server.released
	}
	return server.serveError
}

func (server *controllerOwnershipServer) Shutdown(ctx context.Context) error {
	server.mu.Lock()
	server.state.shutdownCalls++
	server.state.shutdownContext = ctx
	server.mu.Unlock()
	server.shutdownOnce.Do(func() { close(server.shutdownStarted) })
	if server.waitForDeadline {
		<-ctx.Done()
		return ctx.Err()
	}
	if server.shutdownError != nil {
		return server.shutdownError
	}
	server.requestExit()
	return nil
}

func (server *controllerOwnershipServer) Close() error {
	server.mu.Lock()
	server.state.closeCalls++
	server.mu.Unlock()
	server.closeOnce.Do(func() { close(server.closeCalled) })
	server.requestExit()
	return server.closeError
}

func (server *controllerOwnershipServer) requestExit() {
	server.stopOnce.Do(func() { close(server.stop) })
}

func (server *controllerOwnershipServer) release() {
	server.releaseOnce.Do(func() { close(server.released) })
}

func (server *controllerOwnershipServer) snapshot() controllerOwnershipServerState {
	server.mu.Lock()
	defer server.mu.Unlock()
	return server.state
}

// No socket is created. Serve's owner, rather than network behavior, is under test.
type controllerOwnershipListener struct {
	mu         sync.Mutex
	closes     int
	closeError error
}

func (*controllerOwnershipListener) Accept() (net.Conn, error) { return nil, net.ErrClosed }
func (*controllerOwnershipListener) Addr() net.Addr {
	return controllerOwnershipAddress("owned-test-listener")
}

func (listener *controllerOwnershipListener) Close() error {
	listener.mu.Lock()
	defer listener.mu.Unlock()
	listener.closes++
	return listener.closeError
}

func (listener *controllerOwnershipListener) closeCount() int {
	listener.mu.Lock()
	defer listener.mu.Unlock()
	return listener.closes
}

type controllerOwnershipAddress string

func (controllerOwnershipAddress) Network() string        { return "test" }
func (address controllerOwnershipAddress) String() string { return string(address) }

func controllerOwnershipClosed(receipt <-chan struct{}) bool {
	select {
	case <-receipt:
		return true
	default:
		return false
	}
}

func awaitControllerOwnership(t *testing.T, receipt <-chan struct{}, message string) {
	t.Helper()
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	select {
	case <-receipt:
	case <-timer.C:
		t.Fatal(message)
	}
}

func cleanupControllerOwnership(t *testing.T, receipt <-chan struct{}, owner string) {
	t.Helper()
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	select {
	case <-receipt:
	case <-timer.C:
		t.Error("released owner did not actually join: " + owner)
	}
}
