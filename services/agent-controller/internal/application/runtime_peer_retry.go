package application

import (
	"context"
	"errors"
	"sort"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

// Inventory restores this in-memory work set after worker restart or a journal
// gap. No successful journal cursor depends on an Egress acknowledgement.
func (worker *RuntimeObservationWorker) queuePeerInventory(runtimes []ports.RuntimeEnvironmentSnapshot) {
	for _, runtime := range runtimes {
		if runtime.AgentID != "" {
			worker.pendingPeers[runtime.AgentID] = struct{}{}
		}
	}
}

func (worker *RuntimeObservationWorker) reconcilePendingPeers(ctx context.Context) error {
	ids := make([]string, 0, len(worker.pendingPeers))
	for id := range worker.pendingPeers {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	// Resume after the previous attempt so one timed-out peer cannot starve others.
	split := sort.Search(len(ids), func(i int) bool { return ids[i] > worker.lastPeerAttempt })
	ids = append(ids[split:], ids[:split]...)
	var failures []error
	for _, id := range ids {
		if ctx.Err() != nil {
			break
		}
		worker.lastPeerAttempt = id
		current, err := worker.source.InspectRuntime(ctx, id)
		var missing *ports.DependencyError
		if errors.As(err, &missing) && missing.Service == "runtime-controller" && missing.Code == "runtime_not_found" {
			delete(worker.pendingPeers, id)
			continue
		}
		if err == nil && current.AgentID != id {
			err = ErrDependencyUnavailable
		}
		if err == nil && current.LifecycleState == "provisioned" && current.Phase == "running" {
			err = worker.bindCurrentOpenPeer(ctx, current, false, false)
		}
		if err != nil {
			failures = append(failures, err)
			continue
		}
		delete(worker.pendingPeers, id)
	}
	return errors.Join(failures...)
}
