package postgres

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestWaitingRunFreezesCommittedModelConfiguration(t *testing.T) {
	repository, base, seed := sessionConfigurationRepository(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	now := time.Unix(2000, 0).UTC()
	command := acquireRunCommand(base.Agent, "before-edit", "before-edit", now)
	previous, _, err := repository.AcquireRun(ctx, command)
	if err != nil {
		t.Fatal(err)
	}
	releaseConfigurationAdmission(t, repository, previous, now)
	editing, err := repository.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = editing.Rollback(context.Background()) }()
	var editorPID int
	if err := editing.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&editorPID); err != nil {
		t.Fatal(err)
	}
	parameters := seed.Model.Revision.Snapshot().Model.Parameters()
	inputPrice, outputPrice := 3.0, 9.0
	parameters.ContextWindow = 16384
	parameters.Pricing = &domain.ModelPricing{Currency: "USD", InputPerMillion: &inputPrice, OutputPerMillion: &outputPrice}
	payload, err := json.Marshal(parameters)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := editing.Exec(ctx, `UPDATE agent_controller.model_profiles
SET configuration_id='committed-model-config', version=version+1, model=$2 WHERE id=$1`, seed.Model.ModelProfileID, payload); err != nil {
		t.Fatal(err)
	}
	command.RequestID, command.AdmissionID = "after-edit", "after-edit"
	var admitted ports.RunAdmissionRecord
	var admissionErr error
	done := make(chan struct{})
	go func() {
		defer close(done)
		admitted, _, admissionErr = repository.AcquireRun(ctx, command)
	}()
	defer func() { cancel(); <-done }()
	waitForBlockedCatalogQuery(t, ctx, repository, editorPID)
	if err := editing.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	<-done
	if admissionErr != nil {
		t.Fatal(admissionErr)
	}
	if admitted.Snapshot.ExecutionSpec.Configuration.ModelProfileRevisionID != "committed-model-config" ||
		!reflect.DeepEqual(admitted.Snapshot.ExecutionSpec.Model.Parameters(), parameters) {
		t.Fatalf("waiting admission froze mixed or stale configuration: %+v", admitted.Snapshot.ExecutionSpec)
	}
	replayed, found, err := repository.ReplayRunAdmission(ctx, "before-edit", command.RequestFingerprint)
	if err != nil || !found || !reflect.DeepEqual(replayed.Snapshot, previous.Snapshot) {
		t.Fatalf("model edit rewrote previous Run: %v", err)
	}
	releaseConfigurationAdmission(t, repository, admitted, now)
}

func waitForBlockedCatalogQuery(t *testing.T, ctx context.Context, repository *Repository, blockerPID int) {
	t.Helper()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var blocked bool
		err := repository.pool.QueryRow(ctx, `SELECT EXISTS (
SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)))`, blockerPID).Scan(&blocked)
		if err != nil {
			t.Fatal(err)
		}
		if blocked {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal("admission did not wait for the model update", ctx.Err())
		case <-ticker.C:
		}
	}
}
