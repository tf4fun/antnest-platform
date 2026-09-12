package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func sessionConfigurationRepository(t *testing.T) (*Repository, ports.AgentLifecycleBase, rebuildSeed) {
	t.Helper()
	url := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	repository, err := Open(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(repository.Close)
	base, seed := seedAvailableAgentForRebuild(t, context.Background(), repository)
	return repository, base, seed
}

func TestSessionModelSelectionFreezesCompleteRevisionWithoutRebuilding(t *testing.T) {
	repository, base, seed := sessionConfigurationRepository(t)
	ctx := context.Background()
	revised := integrationRevisedModelRecord(t, seed.Model)
	if _, err := repository.ReviseModelProfile(ctx, 1, revised); err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1600, 0).UTC()
	command := acquireRunCommand(base.Agent, "run-config", "admission-config", now)
	command.SessionConfiguration.ModelProfileID = &seed.Model.ModelProfileID
	admission, _, err := repository.AcquireRun(ctx, command)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := admission.Snapshot
	if !reflect.DeepEqual(snapshot.ExecutionSpec.Model, revised.Revision.Snapshot().Model) ||
		snapshot.ExecutionSpec.Provider.ConnectionID != revised.ProviderConnectionID ||
		snapshot.ExecutionSpec.Configuration.ModelProfileRevisionID != revised.Revision.ID() {
		t.Fatalf("selection did not freeze full revision: %+v", snapshot)
	}
	if snapshot.Runtime.RuntimeRevision != base.Agent.RuntimeRevision || snapshot.AgentSpecRevisionID != base.Agent.AgentSpecRevisionID {
		t.Fatal("session selection rebuilt runtime/spec")
	}
	if _, err := repository.GetAdmissionCredential(ctx, admission.AdmissionID, "another-provider", now); !errors.Is(err, ports.ErrCredentialNotAllowed) {
		t.Fatalf("unrelated Provider credential allowed for selected model: %v", err)
	}
	if _, err := repository.GetAdmissionCredential(ctx, admission.AdmissionID, revised.ProviderConnectionID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.pool.Exec(ctx, `UPDATE agent_controller.model_profiles SET enabled = false WHERE id = $1`, seed.Model.ModelProfileID); err != nil {
		t.Fatal(err)
	}
	replayed, ok, err := repository.AcquireRun(ctx, command)
	if err != nil || !ok || !reflect.DeepEqual(replayed.Snapshot, snapshot) {
		t.Fatalf("immutable replay=%+v %v", replayed, err)
	}
	releaseConfigurationAdmission(t, repository, admission, now)
	command.RequestID, command.AdmissionID = "disabled-config", "disabled-config"
	if _, _, err := repository.AcquireRun(ctx, command); !errors.Is(err, ports.ErrModelUnavailable) {
		t.Fatalf("disabled selected model: %v", err)
	}
	command.SessionConfiguration = domain.SessionConfigurationOverrides{}
	if _, _, err := repository.AcquireRun(ctx, command); !errors.Is(err, ports.ErrModelUnavailable) {
		t.Fatalf("disabled inherited model: %v", err)
	}
}

func TestSessionConfigurationDefaultsCASAndRunIsolation(t *testing.T) {
	repository, base, seed := sessionConfigurationRepository(t)
	ctx := context.Background()
	query := ports.SessionConfigurationQuery{AgentID: base.Agent.AgentID, PrincipalID: base.Agent.OwnerUserID,
		ExpectedAccessRevision: base.Agent.AccessRevision, Limit: 100}
	options, err := repository.GetSessionConfiguration(ctx, query)
	if err != nil || len(options.Models) != 1 || options.DefaultModel.RevisionID != seed.Model.Revision.ID() ||
		options.AuthorizationRevision != 1 || options.DefaultAuthorization.Mode != domain.AuthorizationAuto {
		t.Fatalf("options=%+v err=%v", options, err)
	}
	now := time.Unix(1700, 0).UTC()
	admission, _, err := repository.AcquireRun(ctx, acquireRunCommand(base.Agent, "auth-run", "auth-run", now))
	if err != nil {
		t.Fatal(err)
	}
	update := ports.SetAgentAuthorization{Query: query, ExpectedRevision: 1,
		Authorization: domain.Authorization{Mode: domain.AuthorizationChat, ToolRules: []domain.ToolRule{}},
		EventID:       "event-auth-update", TraceID: "trace-auth", Now: now}
	revision, err := repository.SetAgentAuthorization(ctx, update)
	if err != nil || revision != 2 {
		t.Fatalf("CAS revision=%d err=%v", revision, err)
	}
	if _, err := repository.SetAgentAuthorization(ctx, update); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("stale CAS: %v", err)
	}
	replayed, _, err := repository.ReplayRunAdmission(ctx, admission.RequestID, admission.RequestFingerprint)
	if err != nil || replayed.Snapshot.ExecutionSpec.Configuration.Authorization.Mode != domain.AuthorizationAuto {
		t.Fatalf("active Run changed: %+v %v", replayed, err)
	}
	releaseConfigurationAdmission(t, repository, admission, now)
	command := acquireRunCommand(base.Agent, "auth-inherit", "auth-inherit", now)
	inherited, _, err := repository.AcquireRun(ctx, command)
	if err != nil || inherited.Snapshot.ExecutionSpec.Configuration.Authorization.Mode != domain.AuthorizationChat {
		t.Fatalf("inherit=%+v %v", inherited, err)
	}
	releaseConfigurationAdmission(t, repository, inherited, now)
	mode := domain.AuthorizationApprove
	command.RequestID, command.AdmissionID = "auth-override", "auth-override"
	command.SessionConfiguration.AuthorizationMode = &mode
	override, _, err := repository.AcquireRun(ctx, command)
	if err != nil || override.Snapshot.ExecutionSpec.Configuration.Authorization.Mode != mode {
		t.Fatalf("override=%+v %v", override, err)
	}
	if override.Snapshot.ExecutionSpec.Configuration.Digest == inherited.Snapshot.ExecutionSpec.Configuration.Digest {
		t.Fatal("authorization change missing from digest")
	}
	query.PrincipalID = "foreign-user"
	if _, err := repository.GetSessionConfiguration(ctx, query); !errors.Is(err, ports.ErrRunAccessDenied) {
		t.Fatalf("foreign query: %v", err)
	}
	update.Query, update.ExpectedRevision = query, 2
	if _, err := repository.SetAgentAuthorization(ctx, update); !errors.Is(err, ports.ErrRunAccessDenied) {
		t.Fatalf("foreign update: %v", err)
	}
}

func TestSessionModelCatalogIsOrganizationScopedAndSanitized(t *testing.T) {
	repository, base, seed := sessionConfigurationRepository(t)
	ctx := context.Background()
	other := seedConfigurationProfile(t, repository, "another", base.Agent.OrganizationID)
	foreign := seedConfigurationProfile(t, repository, "foreign", "another-org")
	disabled := seedConfigurationProfile(t, repository, "disabled", base.Agent.OrganizationID)
	if _, err := repository.pool.Exec(ctx, `UPDATE agent_controller.model_profiles SET enabled = false WHERE id = $1`, disabled.ModelProfileID); err != nil {
		t.Fatal(err)
	}
	query := ports.SessionConfigurationQuery{AgentID: base.Agent.AgentID, PrincipalID: base.Agent.OwnerUserID, ExpectedAccessRevision: base.Agent.AccessRevision, Limit: 1}
	first, err := repository.GetSessionConfiguration(ctx, query)
	if err != nil || len(first.Models) != 1 || first.NextCursor == "" {
		t.Fatalf("first page=%+v %v", first, err)
	}
	query.AfterID = first.NextCursor
	second, err := repository.GetSessionConfiguration(ctx, query)
	if err != nil || len(second.Models) != 1 || second.NextCursor != "" || second.Models[0].ModelProfileID == first.Models[0].ModelProfileID {
		t.Fatalf("second page=%+v %v", second, err)
	}
	encoded, err := json.Marshal([]ports.SessionConfiguration{first, second})
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"base_url", "credential", "nonce", "ciphertext", "key_version", foreign.ModelProfileID, disabled.ModelProfileID} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("catalog leaks %q: %s", forbidden, encoded)
		}
	}
	access, err := repository.ResolveAgentAccess(ctx, "access-rebuild-integration")
	if err != nil || !access.PromptCapabilities.Image {
		t.Fatalf("organization image model not available to ACP: %+v %v", access, err)
	}
	now := time.Unix(1800, 0).UTC()
	command := acquireRunCommand(base.Agent, "cross-provider", "cross-provider", now)
	command.SessionConfiguration.ModelProfileID = &other.ModelProfileID
	admitted, _, err := repository.AcquireRun(ctx, command)
	if err != nil || admitted.Snapshot.ExecutionSpec.Model.BaseURL != other.Revision.Snapshot().Model.BaseURL || !admitted.Snapshot.ExecutionSpec.Model.SupportsImages {
		t.Fatalf("cross-provider snapshot=%+v %v", admitted, err)
	}
	releaseConfigurationAdmission(t, repository, admitted, now)
	for _, id := range []string{foreign.ModelProfileID, disabled.ModelProfileID, "missing"} {
		command.RequestID, command.AdmissionID = "deny-"+id, "deny-"+id
		command.SessionConfiguration.ModelProfileID = &id
		if _, _, err := repository.AcquireRun(ctx, command); !errors.Is(err, ports.ErrModelUnavailable) {
			t.Fatalf("unavailable model %s: %v", id, err)
		}
	}
	revised := integrationRevisedModelRecord(t, seed.Model)
	if _, err := repository.ReviseModelProfile(ctx, 1, revised); err != nil {
		t.Fatal(err)
	}
	command.RequestID, command.AdmissionID, command.SessionConfiguration = "inherited", "inherited", domain.SessionConfigurationOverrides{}
	pinned, _, err := repository.AcquireRun(ctx, command)
	if err != nil || pinned.Snapshot.ExecutionSpec.Configuration.ModelProfileRevisionID != revised.Revision.ID() {
		t.Fatalf("inherit did not follow current head: %+v %v", pinned, err)
	}
}

func seedConfigurationProfile(t *testing.T, repository *Repository, suffix, organization string) ports.ModelProfileRecord {
	t.Helper()
	record := integrationModelRecord(t)
	id := "profile-" + suffix
	snapshot := record.Revision.Snapshot()
	snapshot.ID, snapshot.ModelProfileID, snapshot.OrganizationID = "revision-"+suffix, id, organization
	record.ProviderConnectionID = "credential-" + suffix
	snapshot.Model.BaseURL, snapshot.Model.SupportsImages = "https://"+suffix+".test/v1", true
	snapshot.Model.ContextWindow = 2147483648
	revision, err := domain.NewModelProfileRevision(domain.ModelProfileRevisionInput(snapshot))
	if err != nil {
		t.Fatal(err)
	}
	record.RequestID, record.ModelProfileID, record.OrganizationID, record.ProfileKey = "create-"+suffix, id, organization, suffix
	record.Revision = revision
	seedProviderForModel(t, repository, record)
	stored, err := repository.PutModelProfile(context.Background(), record)
	if err != nil {
		t.Fatal(err)
	}
	return stored
}

func TestSessionAdmissionLocksModelAvailabilityInBothDirections(t *testing.T) {
	repository, base, seed := sessionConfigurationRepository(t)
	ctx := context.Background()
	for _, admissionFirst := range []bool{false, true} {
		t.Run(fmt.Sprintf("admission_first_%t", admissionFirst), func(t *testing.T) {
			first, err := repository.pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = first.Rollback(ctx) }()
			if admissionFirst {
				_, err = lockRunModel(ctx, first, base.Agent.OrganizationID, seed.Model.ModelProfileID, &seed.Model.ModelProfileID)
			} else {
				_, err = first.Exec(ctx, `UPDATE agent_controller.model_profiles SET enabled = false WHERE id = $1`, seed.Model.ModelProfileID)
			}
			if err != nil {
				t.Fatal(err)
			}
			second, err := repository.pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = second.Rollback(ctx) }()
			if _, err := second.Exec(ctx, `SET LOCAL lock_timeout = '100ms'`); err != nil {
				t.Fatal(err)
			}
			if admissionFirst {
				_, err = second.Exec(ctx, `UPDATE agent_controller.model_profiles SET enabled = false WHERE id = $1`, seed.Model.ModelProfileID)
			} else {
				_, err = lockRunModel(ctx, second, base.Agent.OrganizationID, seed.Model.ModelProfileID, &seed.Model.ModelProfileID)
			}
			var pgErr *pgconn.PgError
			if !errors.As(err, &pgErr) || pgErr.Code != "55P03" {
				t.Fatalf("model decision did not serialize: %v", err)
			}
		})
	}
}

func releaseConfigurationAdmission(t *testing.T, repository *Repository, admission ports.RunAdmissionRecord, now time.Time) {
	t.Helper()
	_, err := repository.FinishRun(context.Background(), finishRunCommand(admission, "finish-"+admission.AdmissionID,
		domain.TerminalReport{Class: domain.TerminalCompleted, ToolEffectState: domain.ToolEffectSettled, StopReason: "end_turn"}, now.Add(time.Second)))
	if err != nil {
		t.Fatal(err)
	}
}
