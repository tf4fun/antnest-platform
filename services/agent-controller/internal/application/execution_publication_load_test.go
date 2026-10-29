package application

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/acpclient"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type publicationLoadStore struct {
	ports.ExecutionPublicationStore
	sources map[string]ports.ExecutionSource
	reads   atomic.Int64
	records atomic.Int64
}

func (store *publicationLoadStore) WithExecutionPublication(ctx context.Context, _ string, action func(context.Context) error) error {
	return action(ctx)
}

func (store *publicationLoadStore) ReadExecutionSource(_ context.Context, organization string) (ports.ExecutionSource, error) {
	store.reads.Add(1)
	return store.sources[organization], nil
}

func (store *publicationLoadStore) GetExecutionSynchronization(_ context.Context, organization string) (ports.ExecutionSynchronization, error) {
	return ports.ExecutionSynchronization{OrganizationID: organization, Revision: store.sources[organization].Revision}, nil
}

func (store *publicationLoadStore) RecordExecutionApplied(context.Context, ports.ExecutionAcknowledgement) error {
	store.records.Add(1)
	return nil
}

type publicationLoadOpener struct {
	box   *credentials.SecretBox
	calls atomic.Int64
}

func (opener *publicationLoadOpener) Open(ctx context.Context, identity ports.CredentialIdentity, sealed ports.SealedSecret) (string, error) {
	opener.calls.Add(1)
	return opener.box.Open(ctx, identity, sealed)
}

type publicationLoadPeer struct {
	mu       sync.Mutex
	current  map[string]ports.ExecutionDigest
	request  atomic.Int64
	response atomic.Int64
	applies  atomic.Int64
	digests  atomic.Int64
}

type publicationLoadSnapshot struct {
	OrganizationID string           `json:"organization_id"`
	SchemaVersion  int              `json:"schema_version"`
	Revision       int64            `json:"revision"`
	Providers      []map[string]any `json:"providers"`
	Models         []map[string]any `json:"models"`
	Agents         []map[string]any `json:"agents"`
}

func publicationLoadDigest(snapshot publicationLoadSnapshot) (ports.ExecutionDigest, error) {
	entries := func(documents []map[string]any, idField string) ([]ports.ExecutionDigestEntry, error) {
		result := make([]ports.ExecutionDigestEntry, 0, len(documents))
		for _, document := range documents {
			delete(document, "credential")
			if runtime, ok := document["runtime"].(map[string]any); ok {
				delete(runtime, "credential")
			}
			id, ok := document[idField].(string)
			if !ok {
				return nil, fmt.Errorf("missing document identifier")
			}
			canonical, err := ports.ExecutionCanonicalJSON(document)
			if err != nil {
				return nil, err
			}
			sum := sha256.Sum256(canonical)
			result = append(result, ports.ExecutionDigestEntry{ID: id, Digest: hex.EncodeToString(sum[:])})
		}
		slices.SortFunc(result, func(a, b ports.ExecutionDigestEntry) int { return strings.Compare(a.ID, b.ID) })
		return result, nil
	}
	providers, err := entries(snapshot.Providers, "connection_id")
	if err != nil {
		return ports.ExecutionDigest{}, err
	}
	models, err := entries(snapshot.Models, "model_profile_id")
	if err != nil {
		return ports.ExecutionDigest{}, err
	}
	agents, err := entries(snapshot.Agents, "agent_id")
	if err != nil {
		return ports.ExecutionDigest{}, err
	}
	result := ports.ExecutionDigest{
		OrganizationID: snapshot.OrganizationID, SchemaVersion: 2, Revision: snapshot.Revision,
		Providers: providers, Models: models, Agents: agents,
	}
	root, err := ports.ExecutionCanonicalJSON(map[string]any{
		"organization_id": result.OrganizationID, "schema_version": result.SchemaVersion, "revision": result.Revision,
		"providers": result.Providers, "models": result.Models, "agents": result.Agents,
		"organization_budget_digest": result.OrganizationBudgetDigest,
	})
	if err != nil {
		return ports.ExecutionDigest{}, err
	}
	sum := sha256.Sum256(root)
	value := hex.EncodeToString(sum[:])
	result.Digest = &value
	return result, nil
}

func (peer *publicationLoadPeer) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	raw, err := io.ReadAll(request.Body)
	if err != nil {
		response.WriteHeader(http.StatusBadRequest)
		return
	}
	peer.request.Add(int64(len(raw)))
	var result any
	switch request.URL.Path {
	case "/rpc/agent-acp/apply-execution-snapshot":
		var snapshot publicationLoadSnapshot
		if json.Unmarshal(raw, &snapshot) != nil {
			response.WriteHeader(http.StatusBadRequest)
			return
		}
		peer.applies.Add(1)
		if snapshot.SchemaVersion == 2 {
			digest, err := publicationLoadDigest(snapshot)
			if err != nil {
				response.WriteHeader(http.StatusInternalServerError)
				return
			}
			peer.mu.Lock()
			peer.current[snapshot.OrganizationID] = digest
			peer.mu.Unlock()
		}
		result = ports.ExecutionAcknowledgement{OrganizationID: snapshot.OrganizationID, AppliedRevision: snapshot.Revision}
	case "/rpc/agent-acp/get-execution-digest":
		var input struct {
			OrganizationID string `json:"organization_id"`
		}
		if json.Unmarshal(raw, &input) != nil {
			response.WriteHeader(http.StatusBadRequest)
			return
		}
		peer.digests.Add(1)
		peer.mu.Lock()
		digest, exists := peer.current[input.OrganizationID]
		peer.mu.Unlock()
		if !exists {
			digest = ports.ExecutionDigest{OrganizationID: input.OrganizationID,
				Providers: []ports.ExecutionDigestEntry{}, Models: []ports.ExecutionDigestEntry{}, Agents: []ports.ExecutionDigestEntry{}}
		}
		result = digest
	default:
		response.WriteHeader(http.StatusNotFound)
		return
	}
	body, err := json.Marshal(result)
	if err != nil {
		response.WriteHeader(http.StatusInternalServerError)
		return
	}
	peer.response.Add(int64(len(body)))
	response.Header().Set("Content-Type", "application/json")
	_, _ = response.Write(body)
}

func publicationLoadSources(t *testing.T, box *credentials.SecretBox) (map[string]ports.ExecutionSource, []string) {
	t.Helper()
	sources := make(map[string]ports.ExecutionSource, 500)
	organizations := make([]string, 0, 500)
	for organization := range 500 {
		id := fmt.Sprintf("load-org-%03d", organization)
		source := executionSource(t)
		source.OrganizationID = id
		source.Providers[0].OrganizationID = id
		identity := ports.CredentialIdentity{OrganizationID: id, CredentialRef: source.Providers[0].ConnectionID,
			CredentialVersion: source.Providers[0].CredentialVersion}
		sealed, err := box.Seal(t.Context(), identity, "synthetic-load-provider-key")
		require.NoError(t, err)
		source.Providers[0].SealedCredential = sealed
		source.Models[0].OrganizationID = id
		model, err := domain.NewModelProfileRevision(domain.ModelProfileRevisionInput{
			ID: "model-config-1", ModelProfileID: "model-1", OrganizationID: id, Revision: 1,
			Model: domain.ModelSpec{BaseURL: source.Providers[0].BaseURL, Model: "current-model", ContextWindow: 8192, MaxOutputTokens: 1024},
		})
		require.NoError(t, err)
		source.Models[0].Revision = model
		agent := source.Agents[0]
		source.Agents = make([]ports.ExecutionAgentSource, 50)
		for index := range 50 {
			current := agent
			current.Agent.AgentID = fmt.Sprintf("agent-%02d", index)
			current.Agent.OrganizationID = id
			current.Agent.DesiredState = domain.DesiredDisabled
			current.Spec.AgentID = current.Agent.AgentID
			current.Spec.Snapshot.SystemPrompt = strings.Repeat("p", 2048)
			source.Agents[index] = current
		}
		sources[id] = source
		organizations = append(organizations, id)
	}
	return sources, organizations
}

func publicationLoadCPU(t *testing.T) time.Duration {
	t.Helper()
	var usage syscall.Rusage
	require.NoError(t, syscall.Getrusage(syscall.RUSAGE_SELF, &usage))
	return time.Duration(usage.Utime.Sec+usage.Stime.Sec)*time.Second +
		time.Duration(usage.Utime.Usec+usage.Stime.Usec)*time.Microsecond
}

func TestExecutionPublication500x50SteadyStateTrafficAndCPU(t *testing.T) {
	box, err := credentials.NewSecretBox(make([]byte, 32))
	require.NoError(t, err)
	sources, organizations := publicationLoadSources(t, box)
	require.Len(t, sources, 500)
	for _, source := range sources {
		require.Len(t, source.Agents, 50)
	}
	type measurement struct {
		WireVersion    int   `json:"wire_version"`
		Organizations  int   `json:"organizations"`
		AgentsEach     int   `json:"agents_each"`
		Cycles         int   `json:"cycles"`
		RequestBytes   int64 `json:"request_body_bytes"`
		ResponseBytes  int64 `json:"response_body_bytes"`
		SourceReads    int64 `json:"source_reads"`
		Decrypts       int64 `json:"decrypts"`
		FullApplies    int64 `json:"full_applies"`
		DigestRequests int64 `json:"digest_requests"`
		CPUUsec        int64 `json:"process_cpu_us"`
		WallUsec       int64 `json:"wall_us"`
	}
	var results []measurement
	for _, version := range []int{1, 2} {
		peer := &publicationLoadPeer{current: make(map[string]ports.ExecutionDigest)}
		server := httptest.NewServer(peer)
		t.Cleanup(server.Close)
		client, err := acpclient.New(server.URL, 10*time.Second, server.Client())
		require.NoError(t, err)
		store := &publicationLoadStore{sources: sources}
		opener := &publicationLoadOpener{box: box}
		publisher := NewExecutionPublisher(store, opener, client, WithExecutionWireVersion(version))
		publish := func() {
			for _, organization := range organizations {
				ack, err := publisher.Publish(t.Context(), organization)
				require.NoError(t, err)
				require.Equal(t, organization, ack.OrganizationID)
				require.Equal(t, sources[organization].Revision, ack.AppliedRevision)
			}
		}
		publish()
		store.reads.Store(0)
		store.records.Store(0)
		opener.calls.Store(0)
		peer.request.Store(0)
		peer.response.Store(0)
		peer.applies.Store(0)
		peer.digests.Store(0)
		runtime.GC()
		cpu := publicationLoadCPU(t)
		started := time.Now()
		publish()
		elapsed := time.Since(started)
		cpu = publicationLoadCPU(t) - cpu
		require.EqualValues(t, 500, store.records.Load())
		results = append(results, measurement{
			WireVersion: version, Organizations: 500, AgentsEach: 50, Cycles: 1,
			RequestBytes: peer.request.Load(), ResponseBytes: peer.response.Load(),
			SourceReads: store.reads.Load(), Decrypts: opener.calls.Load(), FullApplies: peer.applies.Load(),
			DigestRequests: peer.digests.Load(), CPUUsec: cpu.Microseconds(), WallUsec: elapsed.Microseconds(),
		})
		server.Close()
	}
	require.EqualValues(t, 500, results[0].SourceReads)
	require.EqualValues(t, 500, results[0].Decrypts)
	require.EqualValues(t, 500, results[0].FullApplies)
	require.Zero(t, results[0].DigestRequests)
	require.Zero(t, results[1].SourceReads)
	require.Zero(t, results[1].Decrypts)
	require.Zero(t, results[1].FullApplies)
	require.EqualValues(t, 500, results[1].DigestRequests)
	require.Less(t, results[1].RequestBytes+results[1].ResponseBytes, results[0].RequestBytes+results[0].ResponseBytes)
	encoded, err := json.Marshal(results)
	require.NoError(t, err)
	t.Log("publication_500x50_measurement=" + string(encoded))
	t.Log("Scope: one sequential steady-state sweep after warmup; production publisher, HTTP client and AES credential opening; in-memory Controller source/ACK and ACP protocol fixture. CPU includes the HTTP fixture in the same process. HTTP headers, TLS, PostgreSQL, real ACP owner barriers and encryption-at-rest restoration are excluded. No CPU-ratio gate or deployment-throughput claim.")
}
