package postgres

import (
	"context"
	"reflect"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestPromptCapabilitiesUseOnlyCurrentlySelectableModelRevisions(t *testing.T) {
	repository, base, seed := sessionConfigurationRepository(t)
	ctx := context.Background()
	assertPromptCapabilities(t, repository, false, false)
	foreign := seedConfigurationProfile(t, repository, "foreign-native", "foreign-organization")
	setNativeModelCapabilities(t, repository, foreign.Revision.ID(), true)
	assertPromptCapabilities(t, repository, false, false)

	other := seedConfigurationProfile(t, repository, "native", base.Agent.OrganizationID)
	setNativeModelCapabilities(t, repository, other.Revision.ID(), true)
	assertPromptCapabilities(t, repository, true, true)
	if _, err := repository.pool.Exec(ctx, `UPDATE agent_controller.model_profiles SET enabled = false WHERE id = $1`, other.ModelProfileID); err != nil {
		t.Fatal(err)
	}
	assertPromptCapabilities(t, repository, false, false)
	if _, err := repository.pool.Exec(ctx, `UPDATE agent_controller.model_profiles SET enabled = true WHERE id = $1`, other.ModelProfileID); err != nil {
		t.Fatal(err)
	}
	revised := revisedNativeProfile(t, other, false)
	if _, err := repository.ReviseModelProfile(ctx, 1, revised); err != nil {
		t.Fatal(err)
	}
	// An old non-default revision cannot advertise capabilities for the current head.
	assertPromptCapabilities(t, repository, false, false)
	setNativeModelCapabilities(t, repository, seed.Model.Revision.ID(), true)
	revised = revisedNativeProfile(t, seed.Model, false)
	if _, err := repository.ReviseModelProfile(ctx, 1, revised); err != nil {
		t.Fatal(err)
	}
	// Default and selected models both use their current revision.
	assertPromptCapabilities(t, repository, false, false)
	if _, err := repository.pool.Exec(ctx, `UPDATE agent_controller.model_profiles SET enabled = false WHERE id = $1`, seed.Model.ModelProfileID); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.pool.Exec(ctx, `UPDATE agent_controller.agent_access_bindings SET prompt_image = true, prompt_embedded_context = false WHERE agent_id = $1`, base.Agent.AgentID); err != nil {
		t.Fatal(err)
	}
	assertPromptCapabilities(t, repository, false, false)
}

func TestNativeModelCapabilitiesPersistInAdmissionAcrossRevisionAndReopen(t *testing.T) {
	repository, base, seed := sessionConfigurationRepository(t)
	ctx := context.Background()
	revised := revisedNativeProfile(t, seed.Model, true)
	snapshot := revised.Revision.Snapshot()
	if _, err := repository.ReviseModelProfile(ctx, 1, revised); err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1900, 0).UTC()
	command := acquireRunCommand(base.Agent, "native-run", "native-admission", now)
	command.SessionConfiguration.ModelProfileID = &seed.Model.ModelProfileID
	admission, _, err := repository.AcquireRun(ctx, command)
	if err != nil {
		t.Fatal(err)
	}
	if admission.Snapshot.ExecutionSpec.Model != snapshot.Model {
		t.Fatalf("admitted model=%+v want=%+v", admission.Snapshot.ExecutionSpec.Model, snapshot.Model)
	}

	// Reopen the adapter, not the database: recovery must read the frozen JSON snapshot.
	reopened, err := Open(ctx, repository.pool.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if _, err := repository.pool.Exec(ctx, `UPDATE agent_controller.model_profiles SET enabled = false WHERE id = $1`, seed.Model.ModelProfileID); err != nil {
		t.Fatal(err)
	}
	replay, found, err := reopened.ReplayRunAdmission(ctx, command.RequestID, command.RequestFingerprint)
	if err != nil || !found || !reflect.DeepEqual(replay.Snapshot, admission.Snapshot) {
		t.Fatalf("frozen admission changed on reopen: found=%t err=%v", found, err)
	}
	releaseConfigurationAdmission(t, reopened, replay, now)
}

func setNativeModelCapabilities(t *testing.T, repository *Repository, revision string, enabled bool) {
	t.Helper()
	if _, err := repository.pool.Exec(context.Background(), `UPDATE agent_controller.model_profiles
SET model = model || jsonb_build_object('supports_images', $2::boolean, 'supports_audio', $2::boolean, 'supports_pdf', $2::boolean)
WHERE configuration_id = $1`, revision, enabled); err != nil {
		t.Fatal(err)
	}
}

func assertPromptCapabilities(t *testing.T, repository *Repository, image, audio bool) {
	t.Helper()
	access, err := repository.ResolveAgentAccess(context.Background(), "access-rebuild-integration")
	want := ports.PromptCapabilities{Image: image, Audio: audio, EmbeddedContext: true}
	if err != nil || access.PromptCapabilities != want {
		t.Fatalf("capabilities=%+v want=%+v err=%v", access.PromptCapabilities, want, err)
	}
}

func revisedNativeProfile(t *testing.T, current ports.ModelProfileRecord, enabled bool) ports.ModelProfileRecord {
	t.Helper()
	snapshot := current.Revision.Snapshot()
	snapshot.ID += "-next"
	snapshot.Revision++
	snapshot.Model.SupportsImages, snapshot.Model.SupportsAudio, snapshot.Model.SupportsPDF = enabled, enabled, enabled
	revision, err := domain.NewModelProfileRevision(domain.ModelProfileRevisionInput(snapshot))
	if err != nil {
		t.Fatal(err)
	}
	current.Revision, current.RequestID = revision, current.RequestID+"-next"
	current.UpdatedAt = current.UpdatedAt.Add(time.Second)
	return current
}
