package ports

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

func executionV2SnapshotFixture() ExecutionSnapshot {
	reason := "agent_unavailable"
	return ExecutionSnapshot{
		OrganizationID: "org-1", SchemaVersion: 2, Revision: 3,
		Providers: []ExecutionProvider{
			{ConnectionID: "provider-1", ProviderKey: "deepseek", RequestProtocol: "openai_chat_completions",
				BaseURL: "https://api.deepseek.com", Enabled: true, CredentialRevision: "credential-current",
				Credential: &ExecutionCredential{Ref: "provider-1", Version: "credential-current"}},
			{ConnectionID: "provider-2", ProviderKey: "openrouter", RequestProtocol: "openai_chat_completions",
				BaseURL: "https://openrouter.example/api", Enabled: false},
		},
		Models: []ExecutionModel{{ModelParameters: domain.ModelParameters{Model: "current-model", ContextWindow: 8192, MaxOutputTokens: 1024, SupportsImages: true},
			ModelProfileID: "model-1", ConnectionID: "provider-1", DisplayName: "Current model", Enabled: true}},
		Agents: []ExecutionAgent{{AgentID: "agent-1", PrincipalIDs: []string{"owner-1"}, AccessRevision: "access-1",
			UnavailableReason: &reason, DefaultModelProfileID: "model-1",
			DefaultAuthorization:  domain.Authorization{Mode: domain.AuthorizationAuto, ToolRules: []domain.ToolRule{}},
			AuthorizationRevision: 1, SystemPrompt: "", ContextPolicyVersion: domain.ContextPolicyV1,
			SkillInstructions: []ExecutionSkill{}, MaxModelRequests: 8}},
	}
}

func TestExecutionSnapshotV2RequiresCredentialReferences(t *testing.T) {
	require.NoError(t, executionV2SnapshotFixture().Validate())
	for _, change := range []struct {
		name  string
		apply func(*ExecutionProvider)
	}{
		{"plaintext", func(p *ExecutionProvider) {
			p.Credential = &ExecutionCredential{Method: "api_key", Secret: "sk-canary"}
		}},
		{"mixed", func(p *ExecutionProvider) { p.Credential.Secret = "sk-canary" }},
		{"wrong ref", func(p *ExecutionProvider) { p.Credential.Ref = "provider-other" }},
		{"wrong version", func(p *ExecutionProvider) { p.Credential.Version = "credential-other" }},
		{"missing credential", func(p *ExecutionProvider) { p.Credential = nil }},
		{"missing revision", func(p *ExecutionProvider) { p.CredentialRevision = "" }},
	} {
		t.Run(change.name, func(t *testing.T) {
			snapshot := executionV2SnapshotFixture()
			change.apply(&snapshot.Providers[0])
			require.ErrorIs(t, snapshot.Validate(), ErrInvalidExecutionConfiguration)
		})
	}
	snapshot := executionV2SnapshotFixture()
	snapshot.Providers[1].CredentialRevision = "credential-retained"
	snapshot.Providers[1].Credential = &ExecutionCredential{Ref: "provider-2", Version: "credential-retained"}
	require.NoError(t, snapshot.Validate())
	snapshot.Providers[1].CredentialRevision = ""
	require.ErrorIs(t, snapshot.Validate(), ErrInvalidExecutionConfiguration)
}

func TestExecutionSnapshotVersionsDoNotCrossValidate(t *testing.T) {
	legacy := executionV2SnapshotFixture()
	legacy.SchemaVersion = 0
	legacy.Providers[0].Credential = &ExecutionCredential{Method: "api_key", Secret: "sk-legacy"}
	require.NoError(t, legacy.Validate())
	for _, version := range []int{1, 3, -1} {
		snapshot := executionV2SnapshotFixture()
		snapshot.SchemaVersion = version
		require.ErrorIs(t, snapshot.Validate(), ErrInvalidExecutionConfiguration)
	}
	legacy.Providers[0].Credential = &ExecutionCredential{Ref: "provider-1", Version: "credential-current"}
	require.ErrorIs(t, legacy.Validate(), ErrInvalidExecutionConfiguration)
}

func TestExecutionDigestValidation(t *testing.T) {
	hex := strings.Repeat("a", 64)
	absent := ExecutionDigest{OrganizationID: "org-1", SchemaVersion: 0, Revision: 0,
		Providers: []ExecutionDigestEntry{}, Models: []ExecutionDigestEntry{}, Agents: []ExecutionDigestEntry{}}
	require.NoError(t, absent.Validate())
	current := ExecutionDigest{OrganizationID: "org-1", SchemaVersion: 2, Revision: 9, Digest: &hex,
		Providers:                []ExecutionDigestEntry{{ID: "provider-1", Digest: hex}},
		Models:                   []ExecutionDigestEntry{{ID: "model-1", Digest: hex}},
		Agents:                   []ExecutionDigestEntry{{ID: "agent-1", Digest: hex}},
		OrganizationBudgetDigest: &hex}
	require.NoError(t, current.Validate())
	for _, change := range []struct {
		name  string
		apply func(*ExecutionDigest)
	}{
		{"unsupported version", func(d *ExecutionDigest) { d.SchemaVersion = 3 }},
		{"unsafe revision", func(d *ExecutionDigest) { d.Revision = 1 << 53 }},
		{"absent with revision", func(d *ExecutionDigest) { d.SchemaVersion = 0; d.Revision = 5; d.Digest = nil }},
		{"absent with digest", func(d *ExecutionDigest) { d.SchemaVersion = 0; d.Revision = 0; d.Digest = &hex }},
		{"absent with providers", func(d *ExecutionDigest) {
			d.SchemaVersion = 0
			d.Revision = 0
			d.Digest = nil
			d.Providers = []ExecutionDigestEntry{{ID: "provider-1", Digest: hex}}
		}},
		{"present without digest", func(d *ExecutionDigest) { d.Digest = nil }},
		{"present without revision", func(d *ExecutionDigest) { d.Revision = 0 }},
		{"non-hex digest", func(d *ExecutionDigest) { value := "not-a-digest"; d.Digest = &value }},
		{"duplicate IDs", func(d *ExecutionDigest) {
			d.Providers = append(d.Providers, ExecutionDigestEntry{ID: "provider-1", Digest: hex})
		}},
		{"missing collection", func(d *ExecutionDigest) { d.Agents = nil }},
	} {
		t.Run(change.name, func(t *testing.T) {
			digest := current
			digest.Providers = append([]ExecutionDigestEntry{}, current.Providers...)
			change.apply(&digest)
			require.ErrorIs(t, digest.Validate(), ErrInvalidExecutionConfiguration)
		})
	}
}

func TestExecutionDeltaValidation(t *testing.T) {
	snapshot := executionV2SnapshotFixture()
	remote := ExecutionDigest{OrganizationID: "org-1", SchemaVersion: 2, Revision: 1,
		Digest:    ptr(strings.Repeat("a", 64)),
		Providers: []ExecutionDigestEntry{}, Models: []ExecutionDigestEntry{}, Agents: []ExecutionDigestEntry{}}
	delta, err := BuildExecutionDelta(snapshot, remote)
	require.NoError(t, err)
	require.NoError(t, delta.Validate())
	require.Equal(t, 2, delta.SchemaVersion)
	require.EqualValues(t, 1, delta.BaseRevision)
	require.Equal(t, snapshot.Revision, delta.Revision)
	for _, change := range []struct {
		name  string
		apply func(*ExecutionDelta)
	}{
		{"unsupported version", func(d *ExecutionDelta) { d.SchemaVersion = 1 }},
		{"zero base", func(d *ExecutionDelta) { d.BaseRevision = 0 }},
		{"unordered", func(d *ExecutionDelta) { d.Revision = d.BaseRevision }},
		{"unsafe revision", func(d *ExecutionDelta) { d.Revision = 1 << 53 }},
		{"duplicate upsert", func(d *ExecutionDelta) {
			d.Providers.Upserts = append(d.Providers.Upserts, d.Providers.Upserts[0])
		}},
		{"duplicate delete", func(d *ExecutionDelta) { d.Agents.Deletes = []string{"agent-9", "agent-9"} }},
		{"upsert delete overlap", func(d *ExecutionDelta) { d.Models.Deletes = []string{"model-1"} }},
		{"plaintext upsert", func(d *ExecutionDelta) {
			d.Providers.Upserts[0].Credential = &ExecutionCredential{Method: "api_key", Secret: "sk-canary"}
		}},
		{"missing collection", func(d *ExecutionDelta) { d.Agents.Upserts = nil }},
	} {
		t.Run(change.name, func(t *testing.T) {
			candidate, err := BuildExecutionDelta(snapshot, remote)
			require.NoError(t, err)
			change.apply(&candidate)
			require.ErrorIs(t, candidate.Validate(), ErrInvalidExecutionConfiguration)
		})
	}
	encoded, err := json.Marshal(snapshot)
	require.NoError(t, err)
	require.NotContains(t, string(encoded), "secret", "delta construction must not mutate the source snapshot")
}

func TestBuildExecutionDeltaSelectsChangedAndRemovedDocuments(t *testing.T) {
	snapshot := executionV2SnapshotFixture()
	snapshot.OrganizationBudget = &domain.OrganizationBudget{Revision: 4, UnknownCost: "deny"}
	local, err := PublicExecutionDigests(snapshot)
	require.NoError(t, err)
	remote := ExecutionDigest{OrganizationID: "org-1", SchemaVersion: 2, Revision: 2,
		Digest: ptr(strings.Repeat("a", 64)),
		Providers: []ExecutionDigestEntry{
			{ID: "provider-1", Digest: local.Providers["provider-1"]},
			{ID: "provider-2", Digest: local.Providers["provider-2"]}},
		Models: []ExecutionDigestEntry{{ID: "model-1", Digest: strings.Repeat("b", 64)}},
		Agents: []ExecutionDigestEntry{
			{ID: "agent-1", Digest: local.Agents["agent-1"]},
			{ID: "agent-old", Digest: strings.Repeat("c", 64)}},
		OrganizationBudgetDigest: local.OrganizationBudget}
	delta, err := BuildExecutionDelta(snapshot, remote)
	require.NoError(t, err)
	require.EqualValues(t, 2, delta.BaseRevision)
	require.Empty(t, delta.Providers.Upserts, "unchanged Providers are retained")
	require.Empty(t, delta.Providers.Deletes)
	require.Equal(t, []string{"model-1"}, modelDeltaIDs(delta.Models.Upserts))
	require.Empty(t, delta.Models.Deletes)
	require.Empty(t, delta.Agents.Upserts)
	require.Equal(t, []string{"agent-old"}, delta.Agents.Deletes)
	require.Same(t, snapshot.OrganizationBudget, delta.OrganizationBudget)
	remote.Revision = snapshot.Revision
	_, err = BuildExecutionDelta(snapshot, remote)
	require.ErrorIs(t, err, ErrInvalidExecutionConfiguration)
	remote.Revision, remote.OrganizationID = 2, "org-2"
	_, err = BuildExecutionDelta(snapshot, remote)
	require.ErrorIs(t, err, ErrInvalidExecutionConfiguration)
}

func modelDeltaIDs(models []ExecutionModel) []string {
	ids := make([]string, 0, len(models))
	for _, model := range models {
		ids = append(ids, model.ModelProfileID)
	}
	return ids
}

func TestPublicExecutionDigestsStripSecretsAndSortPrincipals(t *testing.T) {
	snapshot := executionV2SnapshotFixture()
	snapshot.Agents[0].PrincipalIDs = []string{"owner-z", "owner-a"}
	snapshot.Agents[0].Runtime = &ExecutionRuntime{RuntimeRevision: "rtv-1", RuntimeExecutionID: "boot-1",
		MCPEndpoint: "http://antnest-runtime-agent-1:8093/mcp", ConnectionID: "rci_22222222222222222222222222222222",
		Credential: &RuntimeCredential{Caller: "agent-acp-service", Token: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"}}
	digests, err := PublicExecutionDigests(snapshot)
	require.NoError(t, err)
	for id, digest := range digests.Agents {
		require.Regexp(t, `^[0-9a-f]{64}$`, digest, id)
	}
	other := snapshot
	other.Agents = append([]ExecutionAgent{}, snapshot.Agents...)
	other.Agents[0].Runtime.Credential.Token = "BAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
	changed, err := PublicExecutionDigests(other)
	require.NoError(t, err)
	require.Equal(t, digests.Agents["agent-1"], changed.Agents["agent-1"], "Runtime token must not enter the public hash")
	unsorted := snapshot
	unsorted.Agents = append([]ExecutionAgent{}, snapshot.Agents...)
	unsorted.Agents[0].PrincipalIDs = []string{"owner-a", "owner-z"}
	reordered, err := PublicExecutionDigests(unsorted)
	require.NoError(t, err)
	require.Equal(t, digests.Agents["agent-1"], reordered.Agents["agent-1"], "principal order is canonical")
	require.Nil(t, digests.OrganizationBudget)
}

func TestExecutionCanonicalJSONIsDeterministicAndMinimallyEscaped(t *testing.T) {
	agent := executionV2SnapshotFixture().Agents[0]
	agent.SystemPrompt = "see <b>&\u2028end"
	canonical, err := ExecutionCanonicalJSON(agent)
	require.NoError(t, err)
	text := string(canonical)
	require.Contains(t, text, `"see <b>&`)
	require.Contains(t, text, `\u2028`)
	require.NotContains(t, text, `\u003c`)
	require.Less(t, strings.Index(text, `"accepting_runs"`), strings.Index(text, `"agent_id"`), "object keys are lexicographically sorted")
	again, err := ExecutionCanonicalJSON(agent)
	require.NoError(t, err)
	require.Equal(t, canonical, again)
	require.NotContains(t, text, "\n")
}

func ptr[T any](value T) *T { return &value }
