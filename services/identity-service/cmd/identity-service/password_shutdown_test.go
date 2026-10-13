package main

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
)

type blockedPasswordResources struct {
	entered chan struct{}
	release chan struct{}
	closed  atomic.Bool
}

func (r *blockedPasswordResources) Close() {
	close(r.entered)
	<-r.release
	r.closed.Store(true)
}

func (r *blockedPasswordResources) Stats() credentials.PasswordStats {
	stats := credentials.PasswordStats{PeakActive: 2, PeakMemoryKiB: 131072, QueueRejected: 17, WaitExpired: 3, OverBudget: 1}
	if !r.closed.Load() {
		stats.Active, stats.MemoryKiB, stats.Queued = 1, 65536, 1
	}
	return stats
}

func TestPasswordResourceShutdownReceiptWaitsForJoinAndContainsOnlyNumericState(t *testing.T) {
	resources := &blockedPasswordResources{entered: make(chan struct{}), release: make(chan struct{})}
	config := credentials.DefaultPasswordConfig()
	config.MaxConcurrent = 2
	var output bytes.Buffer
	done := make(chan struct{})
	release := sync.OnceFunc(func() { close(resources.release) })
	t.Cleanup(func() {
		release()
		<-done
	})
	go func() {
		defer close(done)
		drainPasswordResources(resources, config, slog.New(slog.NewJSONHandler(&output, nil)))
	}()
	select {
	case <-resources.entered:
	case <-done:
		t.Fatal("shutdown receipt skipped resource Close")
	case <-time.After(2 * time.Second):
		t.Fatal("shutdown never began joining password resources")
	}
	if output.Len() != 0 {
		t.Fatal("resource receipt was emitted before running kernels joined")
	}
	release()
	<-done
	var row map[string]any
	if err := json.Unmarshal(output.Bytes(), &row); err != nil {
		t.Fatal(err)
	}
	if row["msg"] != "Identity password resources drained" || row["level"] != "INFO" {
		t.Fatal("shutdown receipt lost its stable event identity")
	}
	delete(row, "time")
	delete(row, "msg")
	delete(row, "level")
	want := map[string]any{
		"memory_budget_kib": float64(131072), "max_concurrent": float64(2),
		"policy_memory_kib": float64(65536), "policy_iterations": float64(3), "policy_parallelism": float64(2),
		"active": float64(0), "memory_kib": float64(0), "queued": float64(0),
		"peak_active": float64(2), "peak_memory_kib": float64(131072),
		"queue_rejected": float64(17), "wait_expired": float64(3), "over_budget": float64(1),
	}
	if !reflect.DeepEqual(row, want) {
		t.Fatal("shutdown receipt contains stale state, missing counters or unexpected fields")
	}
}
