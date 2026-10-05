package postgres

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/instanceauth"
)

func TestInstanceAuthorityTransactionRollbackAndExactRecovery(t *testing.T) {
	repository, database, ctx := integrationRepository(t)
	issuer, _ := instanceauth.New(bytes.Repeat([]byte{42}, 32))
	operation := integrationOperation("instance-atomic-1", deployment.OperationInitializeRuntime, time.Now().UTC())
	operation.Transition = deployment.LifecycleInitializing
	id := instanceauth.Identity{Scope: "scope-a", AgentID: operation.AgentID, Generation: operation.Generation}
	operation.InstanceAuthentication, _ = issuer.Issue(id)
	// Force the generation claim to fail after the operation and Environment
	// INSERTs: neither the sealed credential nor partial admission may survive.
	if _, err := database.ExecContext(ctx, `ALTER TABLE runtime_controller.generation_claims ADD CONSTRAINT reject_fixture CHECK (false)`); err != nil {
		t.Fatal(err)
	}
	if _, _, err := repository.BeginTransition(ctx, operation); err == nil {
		t.Fatal("claim failure was ignored")
	}
	for _, table := range []string{"operations", "runtime_environments", "generation_claims"} {
		var count int
		if err := database.QueryRowContext(ctx, "SELECT COUNT(*) FROM runtime_controller."+table).Scan(&count); err != nil || count != 0 {
			t.Fatal("partial instance admission survived rollback", table, err)
		}
	}
	if _, err := database.ExecContext(ctx, `ALTER TABLE runtime_controller.generation_claims DROP CONSTRAINT reject_fixture`); err != nil {
		t.Fatal(err)
	}
	accepted, replay, err := repository.BeginTransition(ctx, operation)
	if err != nil || replay {
		t.Fatal("clean admission failed", err)
	}
	// Supplying a different freshly minted candidate for the same accepted
	// request cannot replace the persisted generation authority.
	candidate := operation
	candidate.InstanceAuthentication, _ = issuer.Issue(id)
	recovered, replay, err := repository.BeginTransition(ctx, candidate)
	if err != nil || !replay || recovered.InstanceAuthentication.ConnectionID != accepted.InstanceAuthentication.ConnectionID {
		t.Fatal("exact retry replaced instance authority", err)
	}
	creator, err := repository.GenerationOperation(ctx, accepted.RuntimeKey())
	if err != nil || creator.InstanceAuthentication.ConnectionID != accepted.InstanceAuthentication.ConnectionID {
		t.Fatal("immutable creator lookup lost authority", err)
	}
	var raw string
	if err := database.QueryRowContext(ctx, `SELECT instance_authentication::text FROM runtime_controller.operations WHERE request_id=$1`, operation.RequestID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	for _, caller := range []string{"runtime-controller", "agent-acp-service"} {
		token, err := issuer.Open(id, creator.InstanceAuthentication, caller)
		if err != nil || strings.Contains(raw, token) {
			t.Fatal("journal contains a plaintext token", err)
		}
	}
}
