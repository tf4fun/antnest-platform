package application

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/domain"
)

func TestPreparePersistsBeforeSignalingReconcile(t *testing.T) {
	repository := newMemoryRepository()
	signal := &recordingSignal{repository: repository}
	service, err := NewService(repository, signal, fixedIDs("operation-1"), fixedClock())
	if err != nil {
		t.Fatalf("new service: %v", err)
	}

	result, err := service.Prepare(context.Background(), PrepareInput{
		AgentID: "agent-1", ImageRef: "antnest/runtime:test",
		NetworkMode: domain.NetworkRestricted, IdempotencyKey: "request-1",
	})
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	if result.Operation.ID != "operation-1" || result.Runtime.DesiredGeneration != 1 {
		t.Fatalf("unexpected result: %+v", result)
	}
	if signal.calls != 1 || signal.agentID != "agent-1" {
		t.Fatalf("unexpected signal: %+v", signal)
	}
	if !signal.sawCommittedState {
		t.Fatal("reconcile was signaled before the transaction committed")
	}
	if generation, ok := repository.generations["agent-1/1"]; !ok || generation.Status != domain.GenerationPending ||
		generation.TunnelIPv4 != "100.64.0.2" || generation.AllocatorEpoch != 2 {
		t.Fatalf("generation was not persisted: %+v", repository.generations)
	}
}

func TestPrepareReplayDoesNotWriteOrSignalAgain(t *testing.T) {
	repository := newMemoryRepository()
	signal := &recordingSignal{repository: repository}
	service, err := NewService(repository, signal, fixedIDs("operation-1", "operation-2"), fixedClock())
	if err != nil {
		t.Fatalf("new service: %v", err)
	}
	input := PrepareInput{
		AgentID: "agent-1", ImageRef: "antnest/runtime:test",
		NetworkMode: domain.NetworkRestricted, IdempotencyKey: "request-1",
	}
	first, err := service.Prepare(context.Background(), input)
	if err != nil {
		t.Fatalf("first prepare: %v", err)
	}
	writes := repository.writes

	replay, err := service.Prepare(context.Background(), input)
	if err != nil {
		t.Fatalf("replay prepare: %v", err)
	}
	if !replay.Replayed || replay.Operation.ID != first.Operation.ID {
		t.Fatalf("expected original operation, got %+v", replay)
	}
	if repository.writes != writes {
		t.Fatalf("replay wrote state: before=%d after=%d", writes, repository.writes)
	}
	if signal.calls != 1 {
		t.Fatalf("replay signaled reconcile: %d", signal.calls)
	}
}

func TestNewLifecycleCommandSupersedesPreviousOpenOperation(t *testing.T) {
	repository := newMemoryRepository()
	service, err := NewService(
		repository,
		&recordingSignal{repository: repository},
		fixedIDs("prepare-operation", "stop-operation"),
		fixedClock(),
	)
	if err != nil {
		t.Fatalf("new service: %v", err)
	}
	prepare, err := service.Prepare(context.Background(), PrepareInput{
		AgentID: "agent-1", ImageRef: "antnest/runtime:test",
		NetworkMode: domain.NetworkRestricted, IdempotencyKey: "prepare-1",
	})
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	stop, err := service.Stop(context.Background(), LifecycleInput{
		AgentID: "agent-1", IdempotencyKey: "stop-1",
	})
	if err != nil {
		t.Fatalf("stop: %v", err)
	}
	previous, err := repository.GetOperation(context.Background(), prepare.Operation.ID)
	if err != nil {
		t.Fatalf("get previous operation: %v", err)
	}
	if previous.Status != domain.OperationSuperseded || previous.ErrorCode != "superseded" {
		t.Fatalf("previous operation did not terminate explicitly: %+v", previous)
	}
	current, err := repository.GetOperation(context.Background(), stop.Operation.ID)
	if err != nil || current.Status != domain.OperationPending {
		t.Fatalf("replacement operation = %+v, err=%v", current, err)
	}
}

func TestDispatchedOperationCannotBeSuperseded(t *testing.T) {
	repository, service := preparedRuntime(t)
	operation := onlyOperation(t, repository)
	operation.Status = domain.OperationRunning
	repository.operations[operationKey(operation.Kind, operation.AgentID, operation.IdempotencyKey)] = operation

	_, err := service.Purge(context.Background(), LifecycleInput{
		AgentID: "agent-1", IdempotencyKey: "purge-1",
	})
	if !errors.Is(err, domain.ErrConcurrentWrite) {
		t.Fatalf("dispatched operation was superseded: %v", err)
	}
	if len(repository.operations) != 1 || onlyOperation(t, repository).Status != domain.OperationRunning {
		t.Fatalf("failed supersede changed operations: %+v", repository.operations)
	}
}

func TestPrepareDoesNotSignalWhenTransactionFails(t *testing.T) {
	repository := newMemoryRepository()
	repository.commitErr = errors.New("database unavailable")
	signal := &recordingSignal{repository: repository}
	service, err := NewService(repository, signal, fixedIDs("operation-1"), fixedClock())
	if err != nil {
		t.Fatalf("new service: %v", err)
	}

	_, err = service.Prepare(context.Background(), PrepareInput{
		AgentID: "agent-1", ImageRef: "antnest/runtime:test",
		NetworkMode: domain.NetworkRestricted, IdempotencyKey: "request-1",
	})
	if err == nil || err.Error() != "database unavailable" {
		t.Fatalf("expected database error, got %v", err)
	}
	if signal.calls != 0 {
		t.Fatalf("failed transaction signaled reconcile: %d", signal.calls)
	}
}

func TestLifecycleAndNetworkCommandsUseTheSameCommitBoundary(t *testing.T) {
	repository := newMemoryRepository()
	signal := &recordingSignal{repository: repository}
	service, err := NewService(repository, signal, fixedIDs("prepare", "stop", "network"), fixedClock())
	if err != nil {
		t.Fatalf("new service: %v", err)
	}
	_, err = service.Prepare(context.Background(), PrepareInput{
		AgentID: "agent-1", ImageRef: "antnest/runtime:test",
		NetworkMode: domain.NetworkRestricted, IdempotencyKey: "prepare-1",
	})
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}

	network, err := service.UpdateNetworkPolicy(context.Background(), NetworkPolicyInput{
		AgentID: "agent-1", NetworkMode: domain.NetworkUnrestricted,
		IdempotencyKey: "network-1",
	})
	if err != nil {
		t.Fatalf("update network: %v", err)
	}
	if network.Runtime.NetworkMode != domain.NetworkUnrestricted {
		t.Fatalf("unexpected network plan: %+v", network)
	}
	if network.Generation == nil || network.Generation.Number != 2 ||
		network.Generation.TunnelIPv4 != "100.64.0.3" {
		t.Fatalf("replacement generation was not allocated: %+v", network.Generation)
	}

	stopped, err := service.Stop(context.Background(), LifecycleInput{
		AgentID: "agent-1", IdempotencyKey: "stop-1",
	})
	if err != nil {
		t.Fatalf("stop: %v", err)
	}
	if stopped.Runtime.DesiredState != domain.DesiredStopped || !stopped.RetainWorkspace {
		t.Fatalf("unexpected stop plan: %+v", stopped)
	}
	if signal.calls != 3 {
		t.Fatalf("signals = %d, want 3", signal.calls)
	}
}

func TestReplacementGenerationHealthCompletesNetworkOperation(t *testing.T) {
	repository := newMemoryRepository()
	repository.runtime = &domain.Runtime{
		AgentID: "agent-1", ImageRef: "antnest/runtime:test", SpecDigest: "old-spec",
		NetworkMode: domain.NetworkRestricted, DesiredState: domain.DesiredActive,
		Status: domain.RuntimeReady, DesiredGeneration: 1, ObservedGeneration: 1,
		NetworkPolicyEpoch: 1, ObservedPolicyEpoch: 1, ResourceVersion: 1,
	}
	repository.generations["agent-1/1"] = domain.RuntimeGeneration{
		AgentID: "agent-1", Number: 1, Status: domain.GenerationReady,
		RuntimeInstanceID: "rt-old", NetworkPolicyEpoch: 1, ResourceVersion: 1,
	}
	service, err := NewService(
		repository, &recordingSignal{repository: repository}, fixedIDs("network-operation"), fixedClock(),
	)
	if err != nil {
		t.Fatalf("new service: %v", err)
	}

	plan, err := service.UpdateNetworkPolicy(context.Background(), NetworkPolicyInput{
		AgentID: "agent-1", NetworkMode: domain.NetworkUnrestricted, IdempotencyKey: "network-1",
	})
	if err != nil {
		t.Fatalf("update network: %v", err)
	}
	if plan.Generation == nil {
		t.Fatal("network update did not create replacement generation")
	}
	if _, err := service.RuntimeConnected(context.Background(), ConnectedInput{
		AgentID: "agent-1", Generation: 2, ConnectionEpoch: 1,
		RuntimeInstanceID: plan.Generation.RuntimeInstanceID,
	}); err != nil {
		t.Fatalf("runtime connected: %v", err)
	}
	if _, err := service.RuntimeHealthy(context.Background(), HealthyInput{
		AgentID: "agent-1", Generation: 2, ConnectionEpoch: 1, PolicyEpoch: 2,
	}); err != nil {
		t.Fatalf("runtime healthy: %v", err)
	}
	operation, err := repository.GetOperation(context.Background(), "network-operation")
	if err != nil || operation.Status != domain.OperationSucceeded {
		t.Fatalf("network operation did not complete: operation=%+v err=%v", operation, err)
	}
}

type memoryRepository struct {
	runtime              *domain.Runtime
	generations          map[string]domain.RuntimeGeneration
	operations           map[string]domain.Operation
	writes               int
	commitErr            error
	networkHighWatermark uint64
	allocatorEpoch       uint64
}

func newMemoryRepository() *memoryRepository {
	return &memoryRepository{
		generations:    make(map[string]domain.RuntimeGeneration),
		operations:     make(map[string]domain.Operation),
		allocatorEpoch: 1,
	}
}

func (r *memoryRepository) Transact(_ context.Context, apply func(Transaction) error) error {
	tx := &memoryTransaction{
		runtime: cloneRuntime(r.runtime), generations: cloneGenerations(r.generations),
		operations: cloneOperations(r.operations), networkHighWatermark: r.networkHighWatermark,
		allocatorEpoch: r.allocatorEpoch,
	}
	if err := apply(tx); err != nil {
		return err
	}
	if r.commitErr != nil {
		return r.commitErr
	}
	r.runtime = tx.runtime
	r.generations = tx.generations
	r.operations = tx.operations
	r.networkHighWatermark = tx.networkHighWatermark
	r.allocatorEpoch = tx.allocatorEpoch
	r.writes += tx.writes
	return nil
}

func (r *memoryRepository) GetRuntime(_ context.Context, agentID string) (domain.Runtime, error) {
	if r.runtime == nil || r.runtime.AgentID != agentID {
		return domain.Runtime{}, ErrNotFound
	}
	return *r.runtime, nil
}

func (r *memoryRepository) GetGeneration(
	_ context.Context, agentID string, generation uint64,
) (domain.RuntimeGeneration, error) {
	value, ok := r.generations[generationKey(agentID, generation)]
	if !ok {
		return domain.RuntimeGeneration{}, ErrNotFound
	}
	return value, nil
}

func (r *memoryRepository) GetOpenOperation(
	_ context.Context, agentID string, generation uint64,
) (domain.Operation, error) {
	return findOpenOperation(r.operations, agentID, generation)
}

func (r *memoryRepository) GetOperation(_ context.Context, operationID string) (domain.Operation, error) {
	for _, operation := range r.operations {
		if operation.ID == operationID {
			return operation, nil
		}
	}
	return domain.Operation{}, ErrNotFound
}

func (r *memoryRepository) FindGenerationByInstanceID(
	_ context.Context, runtimeInstanceID string,
) (domain.RuntimeGeneration, error) {
	for _, generation := range r.generations {
		if generation.RuntimeInstanceID == runtimeInstanceID {
			return generation, nil
		}
	}
	return domain.RuntimeGeneration{}, ErrNotFound
}

func (r *memoryRepository) ListReconcileCandidates(
	_ context.Context, now time.Time, _ int,
) ([]string, error) {
	if r.runtime == nil || settled(*r.runtime) {
		return nil, nil
	}
	generation := r.generations[generationKey(r.runtime.AgentID, r.runtime.DesiredGeneration)]
	if generation.NextAttemptAt.After(now) {
		return nil, nil
	}
	return []string{r.runtime.AgentID}, nil
}

func (r *memoryRepository) ListReadyRuntimeIDs(context.Context) ([]string, error) {
	if r.runtime == nil || !settled(*r.runtime) || r.runtime.DesiredState != domain.DesiredActive {
		return nil, nil
	}
	return []string{r.runtime.AgentID}, nil
}

type memoryTransaction struct {
	runtime              *domain.Runtime
	generations          map[string]domain.RuntimeGeneration
	operations           map[string]domain.Operation
	writes               int
	networkHighWatermark uint64
	allocatorEpoch       uint64
}

func (tx *memoryTransaction) GetRuntime(_ context.Context, agentID string) (domain.Runtime, error) {
	if tx.runtime == nil || tx.runtime.AgentID != agentID {
		return domain.Runtime{}, ErrNotFound
	}
	return *tx.runtime, nil
}

func (tx *memoryTransaction) GetGeneration(
	_ context.Context, agentID string, generation uint64,
) (domain.RuntimeGeneration, error) {
	value, ok := tx.generations[generationKey(agentID, generation)]
	if !ok {
		return domain.RuntimeGeneration{}, ErrNotFound
	}
	return value, nil
}

func (tx *memoryTransaction) GetOpenOperation(
	_ context.Context, agentID string, generation uint64,
) (domain.Operation, error) {
	return findOpenOperation(tx.operations, agentID, generation)
}

func (tx *memoryTransaction) GetOperationByIdempotencyKey(
	_ context.Context, kind domain.OperationKind, agentID, key string,
) (domain.Operation, error) {
	operation, ok := tx.operations[operationKey(kind, agentID, key)]
	if !ok {
		return domain.Operation{}, ErrNotFound
	}
	return operation, nil
}

func (tx *memoryTransaction) SaveRuntime(_ context.Context, runtime domain.Runtime) error {
	tx.runtime = &runtime
	tx.writes++
	return nil
}

func (tx *memoryTransaction) SaveGeneration(_ context.Context, generation domain.RuntimeGeneration) error {
	tx.generations[generationKey(generation.AgentID, generation.Number)] = generation
	tx.writes++
	return nil
}

func (tx *memoryTransaction) NextNetworkOffset(context.Context) (uint64, uint64, error) {
	tx.networkHighWatermark++
	tx.allocatorEpoch++
	tx.writes++
	return tx.networkHighWatermark, tx.allocatorEpoch, nil
}

func (tx *memoryTransaction) SaveOperation(_ context.Context, operation domain.Operation) error {
	tx.operations[operationKey(operation.Kind, operation.AgentID, operation.IdempotencyKey)] = operation
	tx.writes++
	return nil
}

func operationKey(kind domain.OperationKind, agentID, key string) string {
	return string(kind) + "\x00" + agentID + "\x00" + key
}

func generationKey(agentID string, generation uint64) string {
	return agentID + "/" + fmt.Sprint(generation)
}

func findOpenOperation(
	operations map[string]domain.Operation, agentID string, generation uint64,
) (domain.Operation, error) {
	var found domain.Operation
	for _, operation := range operations {
		if operation.AgentID != agentID || operation.Generation != generation {
			continue
		}
		switch operation.Status {
		case domain.OperationPending, domain.OperationRunning, domain.OperationUnknown:
			if found.CreatedAt.IsZero() || operation.CreatedAt.After(found.CreatedAt) {
				found = operation
			}
		}
	}
	if found.ID == "" {
		return domain.Operation{}, ErrNotFound
	}
	return found, nil
}

type recordingSignal struct {
	repository        *memoryRepository
	calls             int
	agentID           string
	sawCommittedState bool
}

func (s *recordingSignal) Notify(_ context.Context, agentID string) {
	s.calls++
	s.agentID = agentID
	s.sawCommittedState = s.repository.runtime != nil && len(s.repository.operations) == 1
}

type sequenceIDs struct {
	values []string
	next   int
}

func fixedIDs(values ...string) *sequenceIDs { return &sequenceIDs{values: values} }

func (g *sequenceIDs) NewID() string {
	if g.next >= len(g.values) {
		return "unused-operation-id"
	}
	value := g.values[g.next]
	g.next++
	return value
}

func fixedClock() func() time.Time {
	return func() time.Time { return time.Date(2026, 8, 28, 2, 3, 4, 0, time.UTC) }
}

func cloneRuntime(runtime *domain.Runtime) *domain.Runtime {
	if runtime == nil {
		return nil
	}
	copy := *runtime
	return &copy
}

func cloneOperations(source map[string]domain.Operation) map[string]domain.Operation {
	result := make(map[string]domain.Operation, len(source))
	for key, operation := range source {
		result[key] = operation
	}
	return result
}

func cloneGenerations(source map[string]domain.RuntimeGeneration) map[string]domain.RuntimeGeneration {
	result := make(map[string]domain.RuntimeGeneration, len(source))
	for key, generation := range source {
		result[key] = generation
	}
	return result
}
