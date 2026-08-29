package postgres

import (
	"context"
	"database/sql"
	"os"
	"sync/atomic"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"soft/antnest-platform/services/runtime-controller/internal/application"
	"soft/antnest-platform/services/runtime-controller/internal/domain"
)

func TestRepositoryPrepareRoundTrip(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_TEST_POSTGRES_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_TEST_POSTGRES_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	database, err := sql.Open("pgx", databaseURL)
	if err != nil {
		t.Fatalf("open postgres: %v", err)
	}
	defer database.Close()
	if err := database.PingContext(ctx); err != nil {
		t.Fatalf("ping postgres: %v", err)
	}
	if err := Migrate(ctx, database); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	resetDatabase(t, ctx, database)
	defer resetDatabase(t, context.Background(), database)

	repository, err := New(database)
	if err != nil {
		t.Fatalf("new repository: %v", err)
	}
	service, err := application.NewService(repository, discardSignal{}, fixedID("operation-1"), func() time.Time {
		return time.Date(2026, 8, 28, 8, 9, 10, 0, time.UTC)
	})
	if err != nil {
		t.Fatalf("new service: %v", err)
	}
	input := application.PrepareInput{
		AgentID: "agent-1", ImageRef: "antnest/runtime:test",
		NetworkMode: domain.NetworkRestricted, IdempotencyKey: "prepare-1",
	}
	first, err := service.Prepare(ctx, input)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	replay, err := service.Prepare(ctx, input)
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if !replay.Replayed || replay.Operation.ID != first.Operation.ID {
		t.Fatalf("unexpected replay: first=%+v replay=%+v", first, replay)
	}

	storedRuntime, err := repository.GetRuntime(ctx, "agent-1")
	if err != nil {
		t.Fatalf("get runtime: %v", err)
	}
	storedGeneration, err := repository.GetGeneration(ctx, "agent-1", 1)
	if err != nil {
		t.Fatalf("get generation: %v", err)
	}
	storedOperation, err := repository.GetOperation(ctx, "operation-1")
	if err != nil {
		t.Fatalf("get operation: %v", err)
	}
	if storedRuntime.DesiredGeneration != 1 || storedGeneration.Number != 1 ||
		storedOperation.Status != domain.OperationPending {
		t.Fatalf("unexpected persisted state: runtime=%+v generation=%+v operation=%+v",
			storedRuntime, storedGeneration, storedOperation)
	}
}

func TestRepositoryRetriesSerializableConflict(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_TEST_POSTGRES_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_TEST_POSTGRES_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	database, err := sql.Open("pgx", databaseURL)
	if err != nil {
		t.Fatalf("open postgres: %v", err)
	}
	defer database.Close()
	if err := Migrate(ctx, database); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	resetDatabase(t, ctx, database)
	defer resetDatabase(t, context.Background(), database)

	repository, err := New(database)
	if err != nil {
		t.Fatalf("new repository: %v", err)
	}
	service, err := application.NewService(repository, discardSignal{}, fixedID("operation-retry"), time.Now)
	if err != nil {
		t.Fatalf("new service: %v", err)
	}
	if _, err := service.Prepare(ctx, application.PrepareInput{
		AgentID: "agent-retry", ImageRef: "antnest/runtime:test",
		NetworkMode: domain.NetworkRestricted, IdempotencyKey: "prepare-retry",
	}); err != nil {
		t.Fatalf("prepare runtime: %v", err)
	}

	locked := make(chan struct{})
	release := make(chan struct{})
	firstDone := make(chan error, 1)
	go func() {
		firstDone <- repository.Transact(ctx, func(tx application.Transaction) error {
			runtime, err := tx.GetRuntime(ctx, "agent-retry")
			if err != nil {
				return err
			}
			close(locked)
			<-release
			runtime.ResourceVersion++
			runtime.UpdatedAt = time.Now().UTC()
			return tx.SaveRuntime(ctx, runtime)
		})
	}()
	<-locked

	var attempts atomic.Int32
	secondDone := make(chan error, 1)
	go func() {
		secondDone <- repository.Transact(ctx, func(tx application.Transaction) error {
			attempts.Add(1)
			runtime, err := tx.GetRuntime(ctx, "agent-retry")
			if err != nil {
				return err
			}
			runtime.ResourceVersion++
			runtime.UpdatedAt = time.Now().UTC()
			return tx.SaveRuntime(ctx, runtime)
		})
	}()
	time.Sleep(50 * time.Millisecond)
	close(release)
	if err := <-firstDone; err != nil {
		t.Fatalf("first transaction: %v", err)
	}
	if err := <-secondDone; err != nil {
		t.Fatalf("second transaction after retry: %v", err)
	}
	if attempts.Load() < 2 {
		t.Fatalf("expected serialization retry, got %d attempt(s)", attempts.Load())
	}
}

func resetDatabase(t *testing.T, ctx context.Context, database *sql.DB) {
	t.Helper()
	if _, err := database.ExecContext(ctx,
		"TRUNCATE runtime_operations, runtime_generations, runtimes RESTART IDENTITY CASCADE",
	); err != nil {
		t.Fatalf("reset postgres: %v", err)
	}
}

type discardSignal struct{}

func (discardSignal) Notify(context.Context, string) {}

type fixedID string

func (id fixedID) NewID() string { return string(id) }
