package postgres

import (
	"context"
	"errors"
	"reflect"
	"soft/antnest-platform/services/agent-controller/internal/ports"
	"testing"
	"time"
)

func TestDisabledProviderCannotSupplyRunsOrSessionModels(t *testing.T) {
	repository, base, seed := sessionConfigurationRepository(t)
	ctx := context.Background()
	now := time.Unix(1900, 0).UTC()
	admission, _, err := repository.AcquireRun(ctx, acquireRunCommand(base.Agent, "before-disable", "before-disable", now))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repository.pool.Exec(ctx, `UPDATE agent_controller.provider_connections SET enabled=false WHERE id=$1`, seed.Model.ProviderConnectionID); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.GetAdmissionCredential(ctx, admission.AdmissionID, seed.Model.ProviderConnectionID, now); !errors.Is(err, ports.ErrCredentialNotAllowed) {
		t.Fatalf("disabled credential: %v", err)
	}
	options, err := repository.GetSessionConfiguration(ctx, ports.SessionConfigurationQuery{AgentID: base.Agent.AgentID, PrincipalID: base.Agent.OwnerUserID, ExpectedAccessRevision: base.Agent.AccessRevision, Limit: 100})
	if err != nil || options.DefaultModel.Available || len(options.Models) != 0 {
		t.Fatalf("disabled Provider advertised: %v", err)
	}
	if _, err := repository.GetCurrentModelProfileRevision(ctx, seed.Model.ModelProfileID); !errors.Is(err, ports.ErrDisabledReference) {
		t.Fatalf("disabled Provider usable for build: %v", err)
	}
	releaseConfigurationAdmission(t, repository, admission, now)
	if _, _, err := repository.AcquireRun(ctx, acquireRunCommand(base.Agent, "after-disable", "after-disable", now)); !errors.Is(err, ports.ErrModelUnavailable) {
		t.Fatalf("disabled Provider admitted: %v", err)
	}
}

func TestDefaultRunUsesCurrentModelWithoutChangingBuildSnapshot(t *testing.T) {
	repository, base, seed := sessionConfigurationRepository(t)
	ctx := context.Background()
	now := time.Unix(1900, 0).UTC()
	first, _, err := repository.AcquireRun(ctx, acquireRunCommand(base.Agent, "model-before", "model-before", now))
	if err != nil {
		t.Fatal(err)
	}
	revised := integrationRevisedModelRecord(t, seed.Model)
	if _, err := repository.ReviseModelProfile(ctx, 1, revised); err != nil {
		t.Fatal(err)
	}
	replay, _, err := repository.ReplayRunAdmission(ctx, first.RequestID, first.RequestFingerprint)
	if err != nil || !reflect.DeepEqual(replay.Snapshot, first.Snapshot) {
		t.Fatalf("active snapshot changed: %v", err)
	}
	releaseConfigurationAdmission(t, repository, first, now)
	next, _, err := repository.AcquireRun(ctx, acquireRunCommand(base.Agent, "model-after", "model-after", now))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(next.Snapshot.ExecutionSpec.Model, revised.Revision.Snapshot().Model) {
		t.Fatal("default Run retained obsolete build-time model parameters")
	}
	if next.Snapshot.AgentSpecRevisionID != first.Snapshot.AgentSpecRevisionID || next.Snapshot.Runtime != first.Snapshot.Runtime {
		t.Fatal("model edit rebuilt the Agent or Runtime")
	}
}

func TestCredentialResolutionRequiresCurrentOwnerBinding(t *testing.T) {
	changes := map[string]string{
		"owner revoked": `UPDATE agent_controller.agents SET identity_revocation_sequence=owner_authorization_sequence+1 WHERE id=$1`,
		"owner changed": `WITH changed AS (UPDATE agent_controller.agents SET owner_user_id='another-owner' WHERE id=$1 RETURNING id)
UPDATE agent_controller.agent_access_bindings SET principal_id='another-owner' WHERE agent_id IN (SELECT id FROM changed)`,
		"access changed": `WITH changed AS (UPDATE agent_controller.agents SET access_revision='another-access' WHERE id=$1 RETURNING id)
UPDATE agent_controller.agent_access_bindings SET access_revision='another-access' WHERE agent_id IN (SELECT id FROM changed)`,
		"binding disabled":     `UPDATE agent_controller.agent_access_bindings SET active=false WHERE agent_id=$1`,
		"organization changed": `UPDATE agent_controller.agents SET organization_id='foreign-organization' WHERE id=$1`,
	}
	for name, sql := range changes {
		t.Run(name, func(t *testing.T) {
			repository, base, seed := sessionConfigurationRepository(t)
			ctx := context.Background()
			now := time.Unix(2000, 0).UTC()
			admission, _, err := repository.AcquireRun(ctx, acquireRunCommand(base.Agent, "credential-binding", "credential-binding", now))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := repository.pool.Exec(ctx, sql, base.Agent.AgentID); err != nil {
				t.Fatal(err)
			}
			_, err = repository.GetAdmissionCredential(ctx, admission.AdmissionID, seed.Model.ProviderConnectionID, now)
			if !errors.Is(err, ports.ErrCredentialNotAllowed) {
				t.Fatalf("stale authorization accepted: %v", err)
			}
		})
	}
}
