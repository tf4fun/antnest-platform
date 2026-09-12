package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"reflect"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestModelPricingAdmissionPinsSelectionAndSurvivesReopen(t *testing.T) {
	repository, base, seed := sessionConfigurationRepository(t)
	ctx := context.Background()
	priced := reviseProfilePricing(t, repository, seed.Model, 2, 8)
	now := time.Unix(2000, 0).UTC()
	command := acquireRunCommand(base.Agent, "pricing-inherited", "pricing-inherited", now)
	inherited, _, err := repository.AcquireRun(ctx, command)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(inherited.Snapshot.ExecutionSpec.Model.Pricing, priced.Revision.Snapshot().Model.Pricing) {
		t.Fatal("default Run did not resolve current pricing")
	}
	releaseConfigurationAdmission(t, repository, inherited, now)
	command.RequestID, command.AdmissionID = "pricing-selected", "pricing-selected"
	command.SessionConfiguration.ModelProfileID = &seed.Model.ModelProfileID
	admitted, _, err := repository.AcquireRun(ctx, command)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(admitted.Snapshot.ExecutionSpec.Model.Pricing, priced.Revision.Snapshot().Model.Pricing) {
		t.Fatal("selected revision pricing not frozen")
	}
	free := reviseProfilePricing(t, repository, priced, 0, 0)
	reopened, err := Open(ctx, repository.pool.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	replayed, found, err := reopened.ReplayRunAdmission(ctx, command.RequestID, command.RequestFingerprint)
	if err != nil || !found || !reflect.DeepEqual(replayed.Snapshot, admitted.Snapshot) {
		t.Fatal("price replay changed after revision/reopen")
	}
	receipt, found, err := reopened.ReplayModelProfileRequest(ctx, ports.ReviseModelProfileRequest, priced.RequestID, priced.RequestFingerprint)
	if err != nil || !found || !reflect.DeepEqual(receipt.Revision.Snapshot().Model.Pricing, priced.Revision.Snapshot().Model.Pricing) {
		t.Fatal("old model command response price changed")
	}
	releaseConfigurationAdmission(t, reopened, replayed, now)
	command.RequestID, command.AdmissionID = "pricing-free", "pricing-free"
	next, _, err := reopened.AcquireRun(ctx, command)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(next.Snapshot.ExecutionSpec.Model.Pricing, free.Revision.Snapshot().Model.Pricing) ||
		next.Snapshot.ExecutionSpec.Configuration.Digest == admitted.Snapshot.ExecutionSpec.Configuration.Digest {
		t.Fatal("new selection lost explicit free rates or configuration change")
	}
	if next.Snapshot.Runtime != admitted.Snapshot.Runtime {
		t.Fatal("price revision rebuilt Runtime")
	}
	releaseConfigurationAdmission(t, reopened, next, now)
}

func reviseProfilePricing(t *testing.T, repository *Repository, current ports.ModelProfileRecord, input, output float64) ports.ModelProfileRecord {
	t.Helper()
	snapshot := current.Revision.Snapshot()
	expectedRevision := snapshot.Revision
	snapshot.ID += "-priced"
	snapshot.Revision++
	cacheRead, cacheWrite := 0.0, 3.0
	snapshot.Model.Pricing = &domain.ModelPricing{Currency: "USD", InputPerMillion: &input, OutputPerMillion: &output,
		CacheReadPerMillion: &cacheRead, CacheWritePerMillion: &cacheWrite}
	revision, err := domain.NewModelProfileRevision(domain.ModelProfileRevisionInput(snapshot))
	if err != nil {
		t.Fatal(err)
	}
	current.Revision, current.RequestID = revision, current.RequestID+"-priced"
	fingerprint := sha256.Sum256([]byte(snapshot.ID))
	current.RequestFingerprint = hex.EncodeToString(fingerprint[:])
	current.UpdatedAt = current.UpdatedAt.Add(time.Second)
	result, err := repository.ReviseModelProfile(context.Background(), expectedRevision, current)
	if err != nil {
		t.Fatal(err)
	}
	return result
}
