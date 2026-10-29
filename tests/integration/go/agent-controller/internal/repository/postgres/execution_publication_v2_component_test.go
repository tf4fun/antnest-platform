package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/acpclient"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

const publicationV2Organization = "publication-v2-a"
const publicationV2OtherOrganization = "publication-v2-b"
const publicationV2WaiterAppName = "publication-v2-waiter"

type executionV2OrganizationState struct {
	schema    int
	revision  int64
	providers map[string]string
	models    map[string]string
	agents    map[string]string
	budget    *string
}

type executionV2ACPFixture struct {
	mu            sync.Mutex
	organizations map[string]*executionV2OrganizationState
	applies       atomic.Int64
	deltas        atomic.Int64
	bodies        []string
	holdOrg       string
	hold          chan struct{}
	releaseOnce   sync.Once
}

func newExecutionV2ACPFixture() *executionV2ACPFixture {
	return &executionV2ACPFixture{organizations: map[string]*executionV2OrganizationState{}}
}

func (fixture *executionV2ACPFixture) releaseHold() {
	fixture.releaseOnce.Do(func() {
		if fixture.hold != nil {
			close(fixture.hold)
		}
	})
}

func executionV2DocumentDigest(document map[string]any) (string, error) {
	delete(document, "credential")
	if runtime, ok := document["runtime"].(map[string]any); ok {
		delete(runtime, "credential")
	}
	if raw, ok := document["principal_ids"].([]any); ok {
		ids := make([]string, 0, len(raw))
		for _, value := range raw {
			id, ok := value.(string)
			if !ok {
				return "", fmt.Errorf("principal id is not a string")
			}
			ids = append(ids, id)
		}
		sort.Strings(ids)
		document["principal_ids"] = ids
	}
	canonical, err := ports.ExecutionCanonicalJSON(document)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:]), nil
}

func executionV2Digests(documents []any, idField string) (map[string]string, error) {
	result := map[string]string{}
	for _, raw := range documents {
		document, ok := raw.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("document is not an object")
		}
		id, ok := document[idField].(string)
		if !ok || id == "" {
			return nil, fmt.Errorf("document misses %s", idField)
		}
		digest, err := executionV2DocumentDigest(document)
		if err != nil {
			return nil, err
		}
		if _, duplicate := result[id]; duplicate {
			return nil, fmt.Errorf("duplicate document %s", id)
		}
		result[id] = digest
	}
	return result, nil
}

func (fixture *executionV2ACPFixture) state(organization string) *executionV2OrganizationState {
	current := fixture.organizations[organization]
	if current == nil {
		current = &executionV2OrganizationState{providers: map[string]string{}, models: map[string]string{}, agents: map[string]string{}}
		fixture.organizations[organization] = current
	}
	return current
}

func executionV2DigestEntries(digests map[string]string) []any {
	ids := make([]string, 0, len(digests))
	for id := range digests {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	entries := make([]any, 0, len(ids))
	for _, id := range ids {
		entries = append(entries, map[string]any{"id": id, "digest": digests[id]})
	}
	return entries
}

func (fixture *executionV2ACPFixture) digestResponse(organization string) map[string]any {
	state := fixture.state(organization)
	response := map[string]any{
		"organization_id":            organization,
		"schema_version":             state.schema,
		"revision":                   state.revision,
		"digest":                     nil,
		"providers":                  executionV2DigestEntries(state.providers),
		"models":                     executionV2DigestEntries(state.models),
		"agents":                     executionV2DigestEntries(state.agents),
		"organization_budget_digest": state.budget,
	}
	if state.schema > 0 {
		root, err := ports.ExecutionCanonicalJSON(response)
		if err == nil {
			sum := sha256.Sum256(root)
			response["digest"] = hex.EncodeToString(sum[:])
		}
	}
	return response
}

func (fixture *executionV2ACPFixture) applySnapshot(document map[string]any) error {
	organization, _ := document["organization_id"].(string)
	revision, ok := document["revision"].(json.Number)
	if !ok {
		return fmt.Errorf("snapshot revision is not a number")
	}
	schema := int64(1)
	if value, present := document["schema_version"]; present {
		version, ok := value.(json.Number)
		if !ok {
			return fmt.Errorf("schema_version is not a number")
		}
		schema, _ = version.Int64()
	}
	revisionValue, err := revision.Int64()
	if err != nil {
		return err
	}
	state := fixture.state(organization)
	providers, err := executionV2Digests(asArray(document["providers"]), "connection_id")
	if err != nil {
		return err
	}
	models, err := executionV2Digests(asArray(document["models"]), "model_profile_id")
	if err != nil {
		return err
	}
	agents, err := executionV2Digests(asArray(document["agents"]), "agent_id")
	if err != nil {
		return err
	}
	var budget *string
	if value, present := document["organization_budget"]; present && value != nil {
		object, ok := value.(map[string]any)
		if !ok {
			return fmt.Errorf("organization_budget is not an object")
		}
		digest, err := executionV2DocumentDigest(object)
		if err != nil {
			return err
		}
		budget = &digest
	}
	state.schema, state.revision = int(schema), revisionValue
	state.providers, state.models, state.agents, state.budget = providers, models, agents, budget
	return nil
}

func (fixture *executionV2ACPFixture) applyDelta(document map[string]any) (int, string) {
	organization, _ := document["organization_id"].(string)
	state := fixture.state(organization)
	version, _ := document["schema_version"].(json.Number)
	base, _ := document["base_revision"].(json.Number)
	revision, _ := document["revision"].(json.Number)
	versionValue, _ := version.Int64()
	baseValue, _ := base.Int64()
	revisionValue, _ := revision.Int64()
	if versionValue != 2 || revisionValue <= baseValue {
		return http.StatusBadRequest, "invalid_execution_configuration"
	}
	if state.schema == 0 || baseValue != state.revision {
		return http.StatusConflict, "configuration_base_mismatch"
	}
	for _, collection := range []struct {
		name   string
		id     string
		target map[string]string
	}{
		{"providers", "connection_id", state.providers},
		{"models", "model_profile_id", state.models},
		{"agents", "agent_id", state.agents},
	} {
		delta, ok := document[collection.name].(map[string]any)
		if !ok {
			return http.StatusBadRequest, "invalid_execution_configuration"
		}
		upserts, err := executionV2Digests(asArray(delta["upserts"]), collection.id)
		if err != nil {
			return http.StatusBadRequest, "invalid_execution_configuration"
		}
		for id, digest := range upserts {
			collection.target[id] = digest
		}
		for _, raw := range asArray(delta["deletes"]) {
			id, _ := raw.(string)
			delete(collection.target, id)
		}
	}
	state.revision = revisionValue
	return 0, ""
}

func asArray(value any) []any {
	if items, ok := value.([]any); ok {
		return items
	}
	return nil
}

func (fixture *executionV2ACPFixture) handler() http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		raw, err := io.ReadAll(request.Body)
		if err != nil {
			response.WriteHeader(http.StatusBadRequest)
			return
		}
		fixture.mu.Lock()
		fixture.bodies = append(fixture.bodies, string(raw))
		fixture.mu.Unlock()
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.UseNumber()
		var document map[string]any
		if err := decoder.Decode(&document); err != nil {
			response.WriteHeader(http.StatusBadRequest)
			return
		}
		organization, _ := document["organization_id"].(string)
		fixture.mu.Lock()
		defer fixture.mu.Unlock()
		switch request.URL.Path {
		case "/rpc/agent-acp/get-execution-digest":
			response.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(response).Encode(fixture.digestResponse(organization))
		case "/rpc/agent-acp/apply-execution-snapshot":
			fixture.applies.Add(1)
			if fixture.hold != nil && organization == fixture.holdOrg {
				fixture.mu.Unlock()
				select {
				case <-fixture.hold:
				case <-request.Context().Done():
				}
				fixture.mu.Lock()
				if request.Context().Err() != nil {
					return
				}
			}
			if err := fixture.applySnapshot(document); err != nil {
				response.WriteHeader(http.StatusBadRequest)
				return
			}
			revision, _ := document["revision"].(json.Number)
			value, _ := revision.Int64()
			response.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(response).Encode(ports.ExecutionAcknowledgement{OrganizationID: organization, AppliedRevision: value})
		case "/rpc/agent-acp/apply-execution-delta":
			fixture.deltas.Add(1)
			status, code := fixture.applyDelta(document)
			if status != 0 {
				response.Header().Set("Content-Type", "application/json")
				response.WriteHeader(status)
				_ = json.NewEncoder(response).Encode(map[string]any{"code": code, "message": "remote base mismatch", "retryable": false})
				return
			}
			revision, _ := document["revision"].(json.Number)
			value, _ := revision.Int64()
			response.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(response).Encode(ports.ExecutionAcknowledgement{OrganizationID: organization, AppliedRevision: value})
		default:
			response.WriteHeader(http.StatusBadRequest)
		}
	}
}

type publicationV2ReadCounter struct {
	*Repository
	reads atomic.Int64
}

func (store *publicationV2ReadCounter) ReadExecutionSource(ctx context.Context, organization string) (ports.ExecutionSource, error) {
	store.reads.Add(1)
	return store.Repository.ReadExecutionSource(ctx, organization)
}

func publicationV2DatabaseURL(t *testing.T, observer *Repository) string {
	t.Helper()
	return observer.pool.Config().ConnString()
}

func openPublicationV2Repository(t *testing.T, databaseURL string) *Repository {
	t.Helper()
	repository, err := Open(context.Background(), databaseURL)
	require.NoError(t, err)
	t.Cleanup(repository.Close)
	return repository
}

func newPublicationV2Publisher(t *testing.T, databaseURL, acpURL, applicationName string) (*application.ExecutionPublisher, *publicationV2ReadCounter, *Repository) {
	t.Helper()
	if applicationName != "" {
		if strings.Contains(databaseURL, "?") {
			databaseURL += "&application_name=" + applicationName
		} else {
			databaseURL += "?application_name=" + applicationName
		}
	}
	repository := openPublicationV2Repository(t, databaseURL)
	box, err := credentials.NewSecretBox(make([]byte, 32))
	require.NoError(t, err)
	client, err := acpclient.New(acpURL, 20*time.Second, http.DefaultClient)
	require.NoError(t, err)
	store := &publicationV2ReadCounter{Repository: repository}
	return application.NewExecutionPublisher(store, publicationCredentialOpener{repository: repository, box: box}, client, application.WithExecutionWireVersion(2)), store, repository
}

func TestExecutionPublicationV2ChildWorker(t *testing.T) {
	if os.Getenv("ANTNEST_V2_CHILD") != "1" {
		t.Skip("subprocess worker")
	}
	databaseURL := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	acpURL := os.Getenv("ANTNEST_V2_CHILD_ACP")
	organization := os.Getenv("ANTNEST_V2_CHILD_ORG")
	barrier := os.Getenv("ANTNEST_V2_CHILD_BARRIER")
	resultPath := os.Getenv("ANTNEST_V2_CHILD_RESULT")
	ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
	defer cancel()
	if barrier != "" {
		deadline := time.Now().Add(30 * time.Second)
		for {
			if _, err := os.Stat(barrier); err == nil {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("start barrier never released")
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	repository, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open child repository: %v", err)
	}
	defer repository.Close()
	box, err := credentials.NewSecretBox(make([]byte, 32))
	if err != nil {
		t.Fatalf("child credential box: %v", err)
	}
	client, err := acpclient.New(acpURL, 30*time.Second, http.DefaultClient)
	if err != nil {
		t.Fatalf("child ACP client: %v", err)
	}
	store := &publicationV2ReadCounter{Repository: repository}
	publisher := application.NewExecutionPublisher(store, publicationCredentialOpener{repository: repository, box: box}, client, application.WithExecutionWireVersion(2))
	ack, err := publisher.Publish(ctx, organization)
	if err != nil {
		t.Fatalf("child publish: %v", err)
	}
	result := struct {
		Reads           int64  `json:"reads"`
		AppliedRevision int64  `json:"applied_revision"`
		Organization    string `json:"organization"`
	}{Reads: store.reads.Load(), AppliedRevision: ack.AppliedRevision, Organization: ack.OrganizationID}
	encoded, err := json.Marshal(result)
	if err != nil || len(encoded) > 256 {
		t.Fatalf("child result encoding")
	}
	if err := os.WriteFile(resultPath, encoded, 0o600); err != nil {
		t.Fatalf("child result write: %v", err)
	}
}

func TestExecutionPublicationV2TwoProcessPublicationRace(t *testing.T) {
	observer := providerTestRepository(t)
	box, err := credentials.NewSecretBox(make([]byte, 32))
	require.NoError(t, err)
	catalog := fixtureCatalogService(observer, box, providerTestClock{})
	ctx := t.Context()
	connection, err := catalog.CreateProviderConnection(ctx, providerTestInput("v2-create-race", publicationV2Organization))
	require.NoError(t, err)
	fixture := newExecutionV2ACPFixture()
	fixture.holdOrg = publicationV2Organization
	fixture.hold = make(chan struct{})
	server := httptest.NewServer(fixture.handler())
	databaseURL := publicationV2DatabaseURL(t, observer)
	workspace := t.TempDir()
	barrier := filepath.Join(workspace, "start")
	var children []*exec.Cmd
	t.Cleanup(func() {
		fixture.releaseHold()
		for _, cmd := range children {
			if cmd.ProcessState == nil {
				_ = cmd.Process.Kill()
				_ = cmd.Wait()
			}
		}
		server.Close()
	})
	spawn := func(name string) (*exec.Cmd, string) {
		resultPath := filepath.Join(workspace, name+".json")
		child := exec.CommandContext(ctx, os.Args[0], "-test.run", "^TestExecutionPublicationV2ChildWorker$", "-test.count=1", "-test.timeout=120s")
		child.Env = append(os.Environ(),
			"ANTNEST_V2_CHILD=1",
			"ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL="+databaseURL,
			"ANTNEST_V2_CHILD_ACP="+server.URL,
			"ANTNEST_V2_CHILD_ORG="+publicationV2Organization,
			"ANTNEST_V2_CHILD_BARRIER="+barrier,
			"ANTNEST_V2_CHILD_RESULT="+resultPath,
		)
		require.NoError(t, child.Start())
		children = append(children, child)
		return child, resultPath
	}
	joined := func(cmd *exec.Cmd, resultPath string) (reads, revision int64) {
		t.Helper()
		require.NoError(t, cmd.Wait(), "child publication failed")
		encoded, err := os.ReadFile(resultPath)
		require.NoError(t, err)
		var result struct {
			Reads           int64  `json:"reads"`
			AppliedRevision int64  `json:"applied_revision"`
			Organization    string `json:"organization"`
		}
		require.NoError(t, json.Unmarshal(encoded, &result))
		require.Equal(t, publicationV2Organization, result.Organization)
		return result.Reads, result.AppliedRevision
	}

	first, firstResult := spawn("race-first")
	second, secondResult := spawn("race-second")
	require.NoError(t, os.WriteFile(barrier, []byte("1"), 0o600), "start barrier")
	require.Eventually(t, func() bool { return fixture.applies.Load() == 1 }, 20*time.Second, 5*time.Millisecond,
		"exactly one publisher must reach the held apply")
	fixture.releaseHold()
	readsOne, revisionOne := joined(first, firstResult)
	readsTwo, revisionTwo := joined(second, secondResult)
	require.Equal(t, int64(1), readsOne+readsTwo, "the losing process skips the source build on a verified digest")
	require.Equal(t, int64(1), revisionOne)
	require.Equal(t, int64(1), revisionTwo)
	require.Equal(t, int64(1), fixture.applies.Load())
	require.Zero(t, fixture.deltas.Load())

	_, err = catalog.RotateProviderCredential(ctx, application.RotateProviderCredentialInput{
		RequestID: "v2-rotate-race", OrganizationID: publicationV2Organization, ConnectionID: connection.ConnectionID,
		ExpectedVersion: connection.CredentialVersion,
		Credential:      application.ProviderCredentialInput{Method: "api_key", APIKey: "synthetic-v2-race-secret"},
	})
	require.NoError(t, err)
	third, thirdResult := spawn("race-third")
	fourth, fourthResult := spawn("race-fourth")
	readsThree, revisionThree := joined(third, thirdResult)
	readsFour, revisionFour := joined(fourth, fourthResult)
	require.Equal(t, int64(1), readsThree+readsFour)
	require.Equal(t, int64(2), revisionThree)
	require.Equal(t, int64(2), revisionFour)
	require.Equal(t, int64(1), fixture.applies.Load(), "no second full snapshot after the initial apply")
	require.Equal(t, int64(1), fixture.deltas.Load(), "exactly one delta is applied for the rotated revision")

	state, err := observer.GetExecutionSynchronization(ctx, publicationV2Organization)
	require.NoError(t, err)
	require.Equal(t, state.Revision, state.AppliedRevision)
	for _, secret := range []string{"initial-secret", "synthetic-v2-race-secret"} {
		for _, body := range fixture.bodies {
			require.NotContains(t, body, secret)
		}
	}
	require.Zero(t, observer.pool.Stat().AcquiredConns())
}

func TestExecutionPublicationV2DistinctOrganizationsAndCancelledWaiter(t *testing.T) {
	observer := providerTestRepository(t)
	box, err := credentials.NewSecretBox(make([]byte, 32))
	require.NoError(t, err)
	catalog := fixtureCatalogService(observer, box, providerTestClock{})
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	t.Cleanup(cancel)
	_, err = catalog.CreateProviderConnection(ctx, providerTestInput("v2-create-owner", publicationV2Organization))
	require.NoError(t, err)
	_, err = catalog.CreateProviderConnection(ctx, providerTestInput("v2-create-other", publicationV2OtherOrganization))
	require.NoError(t, err)
	fixture := newExecutionV2ACPFixture()
	fixture.holdOrg = publicationV2Organization
	fixture.hold = make(chan struct{})
	server := httptest.NewServer(fixture.handler())
	databaseURL := publicationV2DatabaseURL(t, observer)
	first, firstStore, firstRepository := newPublicationV2Publisher(t, databaseURL, server.URL, "")
	second, secondStore, secondRepository := newPublicationV2Publisher(t, databaseURL, server.URL, publicationV2WaiterAppName)
	t.Cleanup(func() {
		fixture.releaseHold()
		server.Close()
	})

	type result struct {
		ack ports.ExecutionAcknowledgement
		err error
	}
	start := func(parent context.Context, publisher *application.ExecutionPublisher, organization string) chan result {
		done := make(chan result, 1)
		go func() {
			ack, err := publisher.Publish(parent, organization)
			done <- result{ack: ack, err: err}
		}()
		return done
	}
	held := start(ctx, first, publicationV2Organization)
	require.Eventually(t, func() bool { return fixture.applies.Load() == 1 }, 5*time.Second, 5*time.Millisecond,
		"first publisher must reach the held apply before waiters queue")

	other := start(ctx, second, publicationV2OtherOrganization)
	select {
	case outcome := <-other:
		require.NoError(t, outcome.err)
		require.Equal(t, publicationV2OtherOrganization, outcome.ack.OrganizationID)
	case <-time.After(10 * time.Second):
		t.Fatal("one organization's held publication blocked another organization")
	}
	beforeWaiterReads := secondStore.reads.Load()

	waiterContext, cancelWaiter := context.WithCancel(ctx)
	waiter := make(chan result, 1)
	go func() {
		ack, err := second.Publish(waiterContext, publicationV2Organization)
		waiter <- result{ack: ack, err: err}
	}()
	require.Eventually(t, func() bool {
		var waiting bool
		err := observer.pool.QueryRow(ctx, `SELECT EXISTS (
 SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
   AND application_name=$1)`, publicationV2WaiterAppName).Scan(&waiting)
		return err == nil && waiting
	}, 10*time.Second, 10*time.Millisecond, "waiter must reach the database ownership lock")
	cancelWaiter()
	select {
	case outcome := <-waiter:
		require.ErrorIs(t, outcome.err, context.Canceled)
		require.Empty(t, outcome.ack)
	case <-time.After(10 * time.Second):
		t.Fatal("cancelled waiter never returned")
	}
	require.Equal(t, beforeWaiterReads, secondStore.reads.Load(), "a cancelled waiter never builds a source snapshot")

	fixture.releaseHold()
	select {
	case outcome := <-held:
		require.NoError(t, outcome.err)
		require.EqualValues(t, 1, outcome.ack.AppliedRevision)
	case <-time.After(10 * time.Second):
		t.Fatal("held publication never completed")
	}
	require.EqualValues(t, 2, fixture.applies.Load(), "exactly one full apply per organization")
	require.Zero(t, fixture.deltas.Load())
	require.EqualValues(t, 2, firstStore.reads.Load()+secondStore.reads.Load(), "each organization read the source exactly once")
	require.Zero(t, firstRepository.pool.Stat().AcquiredConns())
	require.Zero(t, secondRepository.pool.Stat().AcquiredConns())
}
