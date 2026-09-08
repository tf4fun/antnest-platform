package telemetry

import (
	"context"
	"fmt"
	"log/slog"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type ObservedIdentityRevocationStore struct {
	next   ports.IdentityRevocationStore
	logger *slog.Logger
}

func ObserveIdentityRevocationStore(next ports.IdentityRevocationStore, logger *slog.Logger) (*ObservedIdentityRevocationStore, error) {
	if next == nil || logger == nil {
		return nil, fmt.Errorf("identity revocation store and logger are required")
	}
	return &ObservedIdentityRevocationStore{next: next, logger: logger}, nil
}

func (store *ObservedIdentityRevocationStore) GetIdentityRevocationCursor(ctx context.Context) (cursor int64, resultErr error) {
	ctx, span, started := startRepositorySpan(ctx, "get_identity_revocation_cursor")
	defer func() {
		finishRepositorySpan(ctx, store.logger, span, started, "get_identity_revocation_cursor", resultErr)
	}()
	return store.next.GetIdentityRevocationCursor(ctx)
}

func (store *ObservedIdentityRevocationStore) ApplyIdentityRevocation(ctx context.Context, cursor int64, event ports.PrincipalRevocation, traceID string) (resultErr error) {
	ctx, span, started := startRepositorySpan(ctx, "apply_identity_revocation")
	defer func() { finishRepositorySpan(ctx, store.logger, span, started, "apply_identity_revocation", resultErr) }()
	return store.next.ApplyIdentityRevocation(ctx, cursor, event, traceID)
}

func (store *ObservedIdentityRevocationStore) ListPendingOwnerRevocations(ctx context.Context, after string, limit int) (items []ports.PendingOwnerRevocation, resultErr error) {
	ctx, span, started := startRepositorySpan(ctx, "list_pending_owner_revocations")
	defer func() {
		finishRepositorySpan(ctx, store.logger, span, started, "list_pending_owner_revocations", resultErr)
	}()
	return store.next.ListPendingOwnerRevocations(ctx, after, limit)
}

var _ ports.IdentityRevocationStore = (*ObservedIdentityRevocationStore)(nil)
