package telemetry

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type ObservedLifecycleStore struct {
	next   ports.LifecycleStore
	logger *slog.Logger
}

func ObserveLifecycleStore(
	next ports.LifecycleStore, logger *slog.Logger,
) (*ObservedLifecycleStore, error) {
	if next == nil || logger == nil {
		return nil, fmt.Errorf("lifecycle store and logger are required")
	}
	return &ObservedLifecycleStore{next: next, logger: logger}, nil
}

func (store *ObservedLifecycleStore) GetLifecycleOperation(
	ctx context.Context, requestID string,
) (ports.LifecycleOperationRecord, error) {
	return observeLifecycleValue(ctx, store, "get_lifecycle_operation", func(callCtx context.Context) (ports.LifecycleOperationRecord, error) {
		return store.next.GetLifecycleOperation(callCtx, requestID)
	})
}

func (store *ObservedLifecycleStore) GetAgentLifecycleBase(
	ctx context.Context, agentID string,
) (ports.AgentLifecycleBase, error) {
	return observeLifecycleValue(ctx, store, "get_agent_lifecycle_base", func(callCtx context.Context) (ports.AgentLifecycleBase, error) {
		return store.next.GetAgentLifecycleBase(callCtx, agentID)
	})
}

func (store *ObservedLifecycleStore) ReplayAgentCreate(
	ctx context.Context, requestID string, fingerprint string,
) (ports.AgentCreateState, bool, error) {
	return observeLifecycleReplay(ctx, store, "replay_agent_create", func(callCtx context.Context) (ports.AgentCreateState, bool, error) {
		return store.next.ReplayAgentCreate(callCtx, requestID, fingerprint)
	})
}

func (store *ObservedLifecycleStore) BeginAgentCreate(
	ctx context.Context, input ports.BeginAgentCreate,
) (ports.AgentCreateState, bool, error) {
	return observeLifecycleReplay(ctx, store, "begin_agent_create", func(callCtx context.Context) (ports.AgentCreateState, bool, error) {
		return store.next.BeginAgentCreate(callCtx, input)
	})
}

func (store *ObservedLifecycleStore) RecordCreateNetwork(
	ctx context.Context,
	requestID string,
	fingerprint string,
	attachment ports.NetworkAttachment,
	nextChildRequestID string,
	now time.Time,
) (ports.AgentCreateState, error) {
	return observeLifecycleValue(ctx, store, "record_create_network", func(callCtx context.Context) (ports.AgentCreateState, error) {
		return store.next.RecordCreateNetwork(
			callCtx, requestID, fingerprint, attachment, nextChildRequestID, now,
		)
	})
}

func (store *ObservedLifecycleStore) RecordCreateRuntime(
	ctx context.Context,
	requestID string,
	fingerprint string,
	runtime ports.RuntimeOperation,
	nextChildRequestID string,
	now time.Time,
) (ports.AgentCreateState, error) {
	return observeLifecycleValue(ctx, store, "record_create_runtime", func(callCtx context.Context) (ports.AgentCreateState, error) {
		return store.next.RecordCreateRuntime(
			callCtx, requestID, fingerprint, runtime, nextChildRequestID, now,
		)
	})
}

func (store *ObservedLifecycleStore) PublishAgentCreate(
	ctx context.Context, input ports.PublishAgentCreate,
) (ports.AgentCreateState, error) {
	return observeLifecycleValue(ctx, store, "publish_agent_create", func(callCtx context.Context) (ports.AgentCreateState, error) {
		return store.next.PublishAgentCreate(callCtx, input)
	})
}

func (store *ObservedLifecycleStore) FailAgentCreate(
	ctx context.Context, input ports.FailAgentCreate,
) (ports.AgentCreateState, error) {
	return observeLifecycleValue(ctx, store, "fail_agent_create", func(callCtx context.Context) (ports.AgentCreateState, error) {
		return store.next.FailAgentCreate(callCtx, input)
	})
}

func (store *ObservedLifecycleStore) ReplayAgentRebuild(
	ctx context.Context, requestID string, fingerprint string,
) (ports.AgentRebuildState, bool, error) {
	return observeLifecycleReplay(ctx, store, "replay_agent_rebuild", func(callCtx context.Context) (ports.AgentRebuildState, bool, error) {
		return store.next.ReplayAgentRebuild(callCtx, requestID, fingerprint)
	})
}

func (store *ObservedLifecycleStore) BeginAgentRebuild(
	ctx context.Context, input ports.BeginAgentRebuild,
) (ports.AgentRebuildState, bool, error) {
	return observeLifecycleReplay(ctx, store, "begin_agent_rebuild", func(callCtx context.Context) (ports.AgentRebuildState, bool, error) {
		return store.next.BeginAgentRebuild(callCtx, input)
	})
}

func (store *ObservedLifecycleStore) RecordAgentRebuildPolicy(
	ctx context.Context,
	requestID string,
	fingerprint string,
	assignment ports.NetworkPolicyAssignment,
	now time.Time,
) (ports.AgentRebuildState, error) {
	return observeLifecycleValue(ctx, store, "record_agent_rebuild_policy", func(callCtx context.Context) (ports.AgentRebuildState, error) {
		return store.next.RecordAgentRebuildPolicy(callCtx, requestID, fingerprint, assignment, now)
	})
}

func (store *ObservedLifecycleStore) SettleAgentRebuildDrain(
	ctx context.Context,
	requestID string,
	fingerprint string,
	nextChildRequestID string,
	now time.Time,
) (ports.AgentRebuildState, error) {
	return observeLifecycleValue(ctx, store, "settle_agent_rebuild_drain", func(callCtx context.Context) (ports.AgentRebuildState, error) {
		return store.next.SettleAgentRebuildDrain(
			callCtx, requestID, fingerprint, nextChildRequestID, now,
		)
	})
}

func (store *ObservedLifecycleStore) AdvanceAgentRebuild(
	ctx context.Context, input ports.AdvanceAgentRebuild,
) (ports.AgentRebuildState, error) {
	return observeLifecycleAdvance(
		ctx, store, "advance_agent_rebuild", input.ExpectedPhase, input.NextPhase,
		func(callCtx context.Context) (ports.AgentRebuildState, error) {
			return store.next.AdvanceAgentRebuild(callCtx, input)
		},
	)
}

func (store *ObservedLifecycleStore) PublishAgentRebuild(
	ctx context.Context, input ports.PublishAgentRebuild,
) (ports.AgentRebuildState, error) {
	return observeLifecycleValue(ctx, store, "publish_agent_rebuild", func(callCtx context.Context) (ports.AgentRebuildState, error) {
		return store.next.PublishAgentRebuild(callCtx, input)
	})
}

func (store *ObservedLifecycleStore) FailAgentRebuild(
	ctx context.Context, input ports.FailAgentRebuild,
) (ports.AgentRebuildState, error) {
	return observeLifecycleValue(ctx, store, "fail_agent_rebuild", func(callCtx context.Context) (ports.AgentRebuildState, error) {
		return store.next.FailAgentRebuild(callCtx, input)
	})
}

func (store *ObservedLifecycleStore) ReplayAgentDisable(
	ctx context.Context, requestID string, fingerprint string,
) (ports.AgentDisableState, bool, error) {
	return observeLifecycleReplay(ctx, store, "replay_agent_disable", func(callCtx context.Context) (ports.AgentDisableState, bool, error) {
		return store.next.ReplayAgentDisable(callCtx, requestID, fingerprint)
	})
}

func (store *ObservedLifecycleStore) BeginAgentDisable(
	ctx context.Context, input ports.BeginAgentDisable,
) (ports.AgentDisableState, bool, error) {
	return observeLifecycleReplay(ctx, store, "begin_agent_disable", func(callCtx context.Context) (ports.AgentDisableState, bool, error) {
		return store.next.BeginAgentDisable(callCtx, input)
	})
}

func (store *ObservedLifecycleStore) RecordAgentDisablePolicy(
	ctx context.Context,
	requestID string,
	fingerprint string,
	assignment ports.NetworkPolicyAssignment,
	now time.Time,
) (ports.AgentDisableState, error) {
	return observeLifecycleValue(ctx, store, "record_agent_disable_policy", func(callCtx context.Context) (ports.AgentDisableState, error) {
		return store.next.RecordAgentDisablePolicy(callCtx, requestID, fingerprint, assignment, now)
	})
}

func (store *ObservedLifecycleStore) SettleAgentDisableDrain(
	ctx context.Context,
	requestID string,
	fingerprint string,
	nextChildRequestID string,
	now time.Time,
) (ports.AgentDisableState, error) {
	return observeLifecycleValue(ctx, store, "settle_agent_disable_drain", func(callCtx context.Context) (ports.AgentDisableState, error) {
		return store.next.SettleAgentDisableDrain(
			callCtx, requestID, fingerprint, nextChildRequestID, now,
		)
	})
}

func (store *ObservedLifecycleStore) AdvanceAgentDisable(
	ctx context.Context, input ports.AdvanceAgentDisable,
) (ports.AgentDisableState, error) {
	return observeLifecycleAdvance(
		ctx, store, "advance_agent_disable", input.ExpectedPhase, input.NextPhase,
		func(callCtx context.Context) (ports.AgentDisableState, error) {
			return store.next.AdvanceAgentDisable(callCtx, input)
		},
	)
}

func (store *ObservedLifecycleStore) PublishAgentDisable(
	ctx context.Context, input ports.PublishAgentDisable,
) (ports.AgentDisableState, error) {
	return observeLifecycleValue(ctx, store, "publish_agent_disable", func(callCtx context.Context) (ports.AgentDisableState, error) {
		return store.next.PublishAgentDisable(callCtx, input)
	})
}

func (store *ObservedLifecycleStore) FailAgentDisable(
	ctx context.Context, input ports.FailAgentDisable,
) (ports.AgentDisableState, error) {
	return observeLifecycleValue(ctx, store, "fail_agent_disable", func(callCtx context.Context) (ports.AgentDisableState, error) {
		return store.next.FailAgentDisable(callCtx, input)
	})
}

func (store *ObservedLifecycleStore) GetAgentEnableBase(
	ctx context.Context, agentID string,
) (ports.AgentEnableBase, error) {
	return observeLifecycleValue(ctx, store, "get_agent_enable_base", func(callCtx context.Context) (ports.AgentEnableBase, error) {
		return store.next.GetAgentEnableBase(callCtx, agentID)
	})
}

func (store *ObservedLifecycleStore) ReplayAgentEnable(
	ctx context.Context, requestID string, fingerprint string,
) (ports.AgentEnableState, bool, error) {
	return observeLifecycleReplay(ctx, store, "replay_agent_enable", func(callCtx context.Context) (ports.AgentEnableState, bool, error) {
		return store.next.ReplayAgentEnable(callCtx, requestID, fingerprint)
	})
}

func (store *ObservedLifecycleStore) BeginAgentEnable(
	ctx context.Context, input ports.BeginAgentEnable,
) (ports.AgentEnableState, bool, error) {
	return observeLifecycleReplay(ctx, store, "begin_agent_enable", func(callCtx context.Context) (ports.AgentEnableState, bool, error) {
		return store.next.BeginAgentEnable(callCtx, input)
	})
}

func (store *ObservedLifecycleStore) AdvanceAgentEnable(
	ctx context.Context, input ports.AdvanceAgentEnable,
) (ports.AgentEnableState, error) {
	return observeLifecycleAdvance(
		ctx, store, "advance_agent_enable", input.ExpectedPhase, input.NextPhase,
		func(callCtx context.Context) (ports.AgentEnableState, error) {
			return store.next.AdvanceAgentEnable(callCtx, input)
		},
	)
}

func (store *ObservedLifecycleStore) PublishAgentEnable(
	ctx context.Context, input ports.PublishAgentEnable,
) (ports.AgentEnableState, error) {
	return observeLifecycleValue(ctx, store, "publish_agent_enable", func(callCtx context.Context) (ports.AgentEnableState, error) {
		return store.next.PublishAgentEnable(callCtx, input)
	})
}

func (store *ObservedLifecycleStore) FailAgentEnable(
	ctx context.Context, input ports.FailAgentEnable,
) (ports.AgentEnableState, error) {
	return observeLifecycleValue(ctx, store, "fail_agent_enable", func(callCtx context.Context) (ports.AgentEnableState, error) {
		return store.next.FailAgentEnable(callCtx, input)
	})
}

func (store *ObservedLifecycleStore) GetAgentDeleteBase(
	ctx context.Context, agentID string,
) (ports.AgentDeleteBase, error) {
	return observeLifecycleValue(ctx, store, "get_agent_delete_base", func(callCtx context.Context) (ports.AgentDeleteBase, error) {
		return store.next.GetAgentDeleteBase(callCtx, agentID)
	})
}

func (store *ObservedLifecycleStore) ReplayAgentDelete(
	ctx context.Context, requestID string, fingerprint string,
) (ports.AgentDeleteState, bool, error) {
	return observeLifecycleReplay(ctx, store, "replay_agent_delete", func(callCtx context.Context) (ports.AgentDeleteState, bool, error) {
		return store.next.ReplayAgentDelete(callCtx, requestID, fingerprint)
	})
}

func (store *ObservedLifecycleStore) BeginAgentDelete(
	ctx context.Context, input ports.BeginAgentDelete,
) (ports.AgentDeleteState, bool, error) {
	return observeLifecycleReplay(ctx, store, "begin_agent_delete", func(callCtx context.Context) (ports.AgentDeleteState, bool, error) {
		return store.next.BeginAgentDelete(callCtx, input)
	})
}

func (store *ObservedLifecycleStore) SettleAgentDeleteDrain(
	ctx context.Context,
	requestID string,
	fingerprint string,
	nextChildRequestID string,
	now time.Time,
) (ports.AgentDeleteState, error) {
	return observeLifecycleValue(ctx, store, "settle_agent_delete_drain", func(callCtx context.Context) (ports.AgentDeleteState, error) {
		return store.next.SettleAgentDeleteDrain(
			callCtx, requestID, fingerprint, nextChildRequestID, now,
		)
	})
}

func (store *ObservedLifecycleStore) AdvanceAgentDelete(
	ctx context.Context, input ports.AdvanceAgentDelete,
) (ports.AgentDeleteState, error) {
	return observeLifecycleAdvance(
		ctx, store, "advance_agent_delete", input.ExpectedPhase, input.NextPhase,
		func(callCtx context.Context) (ports.AgentDeleteState, error) {
			return store.next.AdvanceAgentDelete(callCtx, input)
		},
	)
}

func (store *ObservedLifecycleStore) PublishAgentDelete(
	ctx context.Context, input ports.PublishAgentDelete,
) (ports.AgentDeleteState, error) {
	return observeLifecycleValue(ctx, store, "publish_agent_delete", func(callCtx context.Context) (ports.AgentDeleteState, error) {
		return store.next.PublishAgentDelete(callCtx, input)
	})
}

func observeLifecycleValue[T any](
	ctx context.Context,
	store *ObservedLifecycleStore,
	operation string,
	call func(context.Context) (T, error),
) (value T, resultErr error) {
	ctx, span, started := startRepositorySpan(ctx, operation)
	defer func() { store.finish(ctx, span, started, operation, resultErr) }()
	return call(ctx)
}

func observeLifecycleReplay[T any](
	ctx context.Context,
	store *ObservedLifecycleStore,
	operation string,
	call func(context.Context) (T, bool, error),
) (value T, replayed bool, resultErr error) {
	ctx, span, started := startRepositorySpan(ctx, operation)
	defer func() { store.finish(ctx, span, started, operation, resultErr) }()
	return call(ctx)
}

func observeLifecycleAdvance[T any](
	ctx context.Context,
	store *ObservedLifecycleStore,
	operation string,
	expectedPhase domain.OperationPhase,
	nextPhase domain.OperationPhase,
	call func(context.Context) (T, error),
) (value T, resultErr error) {
	ctx, span, started := startRepositorySpan(ctx, operation)
	span.SetAttributes(
		attribute.String("antnest.lifecycle.expected_phase", string(expectedPhase)),
		attribute.String("antnest.lifecycle.next_phase", string(nextPhase)),
	)
	defer func() { store.finish(ctx, span, started, operation, resultErr) }()
	return call(ctx)
}

func (store *ObservedLifecycleStore) finish(
	ctx context.Context,
	span trace.Span,
	started time.Time,
	operation string,
	err error,
) {
	finishRepositorySpan(ctx, store.logger, span, started, operation, err)
}

var _ ports.LifecycleStore = (*ObservedLifecycleStore)(nil)
