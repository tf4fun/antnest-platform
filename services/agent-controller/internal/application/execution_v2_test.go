package application

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestExecutionProjectionV2PublishesCredentialReferencesWithoutOpening(t *testing.T) {
	source := executionSource(t)
	legacy, err := BuildExecutionSnapshot(t.Context(), source, &executionCredentialOpener{})
	require.NoError(t, err)
	snapshot, err := BuildExecutionSnapshotV2(t.Context(), source)
	require.NoError(t, err)
	require.Equal(t, 2, snapshot.SchemaVersion)
	require.Equal(t, legacy.Models, snapshot.Models)
	require.Equal(t, legacy.Agents, snapshot.Agents)
	require.Equal(t, legacy.OrganizationBudget, snapshot.OrganizationBudget)
	provider := snapshot.Providers[0]
	require.Equal(t, "provider-1", provider.ConnectionID)
	require.Equal(t, "credential-current", provider.CredentialRevision)
	require.Equal(t, &ports.ExecutionCredential{Ref: "provider-1", Version: "credential-current"}, provider.Credential)
	require.NoError(t, snapshot.Validate())
	encoded, err := json.Marshal(snapshot)
	require.NoError(t, err)
	for _, canary := range []string{"synthetic-current-secret", `"secret"`, `"method"`} {
		require.NotContains(t, string(encoded), canary)
	}
	require.Contains(t, string(encoded), `"schema_version":2`)
	source.Providers[0].Enabled = false
	snapshot, err = BuildExecutionSnapshotV2(t.Context(), source)
	require.NoError(t, err)
	require.Equal(t, &ports.ExecutionCredential{Ref: "provider-1", Version: "credential-current"}, snapshot.Providers[0].Credential)
}

type panickingExecutionOpener struct{ calls int }

func (opener *panickingExecutionOpener) Open(context.Context, ports.CredentialIdentity, ports.SealedSecret) (string, error) {
	opener.calls++
	return "", errors.New("v2 capacity must not decrypt " + "sk-canary")
}

func TestExecutionCapacityV2NeverDecryptsCredentials(t *testing.T) {
	source := executionSource(t)
	opener := &panickingExecutionOpener{}
	capacity, err := NewExecutionCapacity(opener, 1<<20, WithExecutionCapacityWireVersion(2))
	require.NoError(t, err)
	input := ports.ExecutionCapacityInput{Current: source, Targets: []ports.AgentSpecRecord{source.Agents[0].Spec}}
	before, err := capacity.RequiredBytes(t.Context(), input)
	require.NoError(t, err)
	require.Zero(t, opener.calls)
	require.Positive(t, before)
}

type executionV2ClientStub struct {
	executionPublicationClientStub
	digest func(context.Context, string) (ports.ExecutionDigest, error)
	delta  func(context.Context, ports.ExecutionDelta) (ports.ExecutionAcknowledgement, error)
}

func (client *executionV2ClientStub) GetExecutionDigest(ctx context.Context, organizationID string) (ports.ExecutionDigest, error) {
	return client.digest(ctx, organizationID)
}

func (client *executionV2ClientStub) ApplyExecutionDelta(ctx context.Context, delta ports.ExecutionDelta) (ports.ExecutionAcknowledgement, error) {
	return client.delta(ctx, delta)
}

func currentV2Digest(t *testing.T, source ports.ExecutionSource) ports.ExecutionDigest {
	t.Helper()
	snapshot, err := BuildExecutionSnapshotV2(t.Context(), source)
	require.NoError(t, err)
	resolver := fixtureExecutionRuntimeResolver()
	for index := range snapshot.Agents {
		agent := &snapshot.Agents[index]
		if !agent.AcceptingRuns {
			continue
		}
		connection, err := resolver.ResolveRuntimeConnection(t.Context(), agent.AgentID, agent.Runtime.RuntimeRevision, agent.Runtime.RuntimeExecutionID)
		require.NoError(t, err)
		agent.Runtime.ConnectionID, agent.Runtime.Credential = connection.ConnectionID, &connection.Credential
	}
	local, err := ports.PublicExecutionDigests(snapshot)
	require.NoError(t, err)
	entries := func(digests map[string]string) []ports.ExecutionDigestEntry {
		result := make([]ports.ExecutionDigestEntry, 0, len(digests))
		for id, digest := range digests {
			result = append(result, ports.ExecutionDigestEntry{ID: id, Digest: digest})
		}
		return result
	}
	root := strings.Repeat("a", 64)
	return ports.ExecutionDigest{OrganizationID: source.OrganizationID, SchemaVersion: 2, Revision: source.Revision,
		Digest: &root, Providers: entries(local.Providers), Models: entries(local.Models), Agents: entries(local.Agents),
		OrganizationBudgetDigest: local.OrganizationBudget}
}

func newV2PublicationFixture(t *testing.T, remote ports.ExecutionDigest) (*executionPublicationStoreStub, *executionV2ClientStub, *executionCredentialOpener, *[]string) {
	t.Helper()
	source := executionSource(t)
	stages := &[]string{}
	store := &executionPublicationStoreStub{
		synchronization: func(context.Context, string) (ports.ExecutionSynchronization, error) {
			*stages = append(*stages, "sync")
			return ports.ExecutionSynchronization{OrganizationID: "org-1", Revision: source.Revision, AppliedRevision: 0}, nil
		},
		read: func(context.Context, string) (ports.ExecutionSource, error) {
			*stages = append(*stages, "read")
			return source, nil
		},
		record: func(_ context.Context, acknowledgement ports.ExecutionAcknowledgement) error {
			*stages = append(*stages, "record")
			require.Equal(t, source.Revision, acknowledgement.AppliedRevision)
			return nil
		},
	}
	client := &executionV2ClientStub{
		executionPublicationClientStub: executionPublicationClientStub{apply: func(_ context.Context, snapshot ports.ExecutionSnapshot) (ports.ExecutionAcknowledgement, error) {
			*stages = append(*stages, "apply")
			require.Equal(t, 2, snapshot.SchemaVersion)
			for _, provider := range snapshot.Providers {
				require.NotNil(t, provider.Credential)
				require.Empty(t, provider.Credential.Secret)
				require.Equal(t, provider.ConnectionID, provider.Credential.Ref)
			}
			return ports.ExecutionAcknowledgement{OrganizationID: snapshot.OrganizationID, AppliedRevision: snapshot.Revision}, nil
		}},
		digest: func(_ context.Context, organizationID string) (ports.ExecutionDigest, error) {
			*stages = append(*stages, "digest")
			return remote, nil
		},
		delta: func(_ context.Context, delta ports.ExecutionDelta) (ports.ExecutionAcknowledgement, error) {
			*stages = append(*stages, "delta")
			return ports.ExecutionAcknowledgement{OrganizationID: delta.OrganizationID, AppliedRevision: delta.Revision}, nil
		},
	}
	opener := &executionCredentialOpener{}
	return store, client, opener, stages
}

func v2Publisher(store *executionPublicationStoreStub, opener *executionCredentialOpener, client *executionV2ClientStub) *ExecutionPublisher {
	return NewExecutionPublisher(store, opener, client,
		WithRuntimeConnectionResolver(fixtureExecutionRuntimeResolver()), WithExecutionWireVersion(2))
}

func TestExecutionPublisherV2CurrentDigestSkipsBuildAndApply(t *testing.T) {
	source := executionSource(t)
	remote := currentV2Digest(t, source)
	store, client, opener, stages := newV2PublicationFixture(t, remote)
	publisher := v2Publisher(store, opener, client)
	acknowledgement, err := publisher.Publish(t.Context(), "org-1")
	require.NoError(t, err)
	require.Equal(t, source.Revision, acknowledgement.AppliedRevision)
	require.Equal(t, []string{"sync", "digest", "record"}, *stages)
	require.Empty(t, opener.calls, "verified digest ACK never decrypts")
}

func TestExecutionPublisherV2RemoteNewerThanLocalIsInvalid(t *testing.T) {
	source := executionSource(t)
	remote := currentV2Digest(t, source)
	remote.Revision = source.Revision + 1
	_, client, _, _ := newV2PublicationFixture(t, remote)
	_, err := v2Publisher(&executionPublicationStoreStub{
		synchronization: func(context.Context, string) (ports.ExecutionSynchronization, error) {
			return ports.ExecutionSynchronization{OrganizationID: "org-1", Revision: source.Revision}, nil
		},
	}, &executionCredentialOpener{}, client).Publish(t.Context(), "org-1")
	var dependency *ports.DependencyError
	require.ErrorAs(t, err, &dependency)
	require.Equal(t, "invalid_response", dependency.Code)
}

func TestExecutionPublisherV2AbsentAndLegacyRemoteSendFullSnapshot(t *testing.T) {
	for _, name := range []string{"absent", "legacy", "legacy-equal"} {
		t.Run(name, func(t *testing.T) {
			source := executionSource(t)
			remote := ports.ExecutionDigest{OrganizationID: "org-1", SchemaVersion: 0, Revision: 0,
				Providers: []ports.ExecutionDigestEntry{}, Models: []ports.ExecutionDigestEntry{}, Agents: []ports.ExecutionDigestEntry{}}
			if name != "absent" {
				root := strings.Repeat("b", 64)
				remote.SchemaVersion, remote.Revision, remote.Digest = 1, source.Revision-1, &root
				if name == "legacy-equal" {
					remote.Revision = source.Revision
				}
			}
			store, client, opener, stages := newV2PublicationFixture(t, remote)
			_, err := v2Publisher(store, opener, client).Publish(t.Context(), "org-1")
			require.NoError(t, err)
			require.Equal(t, []string{"sync", "digest", "read", "apply", "record"}, *stages)
			require.Empty(t, opener.calls)
			remote = currentV2Digest(t, source)
			client.digest = func(_ context.Context, organizationID string) (ports.ExecutionDigest, error) {
				*stages = append(*stages, "digest")
				return remote, nil
			}
			*stages = nil
			_, err = v2Publisher(store, opener, client).Publish(t.Context(), "org-1")
			require.NoError(t, err)
			require.Equal(t, []string{"sync", "digest", "record"}, *stages)
		})
	}
}

func TestExecutionPublisherV2DeltaSelectsUpsertsAndDeletes(t *testing.T) {
	source := executionSource(t)
	remote := currentV2Digest(t, source)
	remote.Revision = source.Revision - 1
	stale := strings.Repeat("c", 64)
	remote.Models = []ports.ExecutionDigestEntry{{ID: "model-1", Digest: stale}}
	remote.Agents = append(remote.Agents, ports.ExecutionDigestEntry{ID: "agent-old", Digest: stale})
	store, client, opener, stages := newV2PublicationFixture(t, remote)
	var received ports.ExecutionDelta
	client.delta = func(_ context.Context, delta ports.ExecutionDelta) (ports.ExecutionAcknowledgement, error) {
		*stages = append(*stages, "delta")
		received = delta
		return ports.ExecutionAcknowledgement{OrganizationID: delta.OrganizationID, AppliedRevision: delta.Revision}, nil
	}
	acknowledgement, err := v2Publisher(store, opener, client).Publish(t.Context(), "org-1")
	require.NoError(t, err)
	require.Equal(t, source.Revision, acknowledgement.AppliedRevision)
	require.Equal(t, []string{"sync", "digest", "read", "delta", "record"}, *stages)
	require.Equal(t, 2, received.SchemaVersion)
	require.Equal(t, remote.Revision, received.BaseRevision)
	require.Empty(t, opener.calls)
	require.Empty(t, received.Providers.Upserts, "identical public digests retain Provider documents")
	require.Empty(t, received.Providers.Deletes)
	require.Equal(t, "model-1", received.Models.Upserts[0].ModelProfileID)
	require.Empty(t, received.Agents.Upserts)
	require.Equal(t, []string{"agent-old"}, received.Agents.Deletes)
	require.Nil(t, received.OrganizationBudget)
	encoded, err := json.Marshal(received)
	require.NoError(t, err)
	require.Contains(t, string(encoded), `"organization_budget":null`)
	require.NotContains(t, string(encoded), "synthetic-current-secret")
}

func TestExecutionPublisherV2BaseMismatchFallsBackExactlyOnce(t *testing.T) {
	source := executionSource(t)
	remote := currentV2Digest(t, source)
	remote.Revision = source.Revision - 1
	store, client, _, stages := newV2PublicationFixture(t, remote)
	client.delta = func(context.Context, ports.ExecutionDelta) (ports.ExecutionAcknowledgement, error) {
		*stages = append(*stages, "delta")
		return ports.ExecutionAcknowledgement{}, &ports.DependencyError{Service: "agent-acp-service", Code: "configuration_base_mismatch", Retryable: false}
	}
	acknowledgement, err := v2Publisher(store, &executionCredentialOpener{}, client).Publish(t.Context(), "org-1")
	require.NoError(t, err)
	require.Equal(t, source.Revision, acknowledgement.AppliedRevision)
	require.Equal(t, []string{"sync", "digest", "read", "delta", "apply", "record"}, *stages)
}

func TestExecutionPublisherV2OtherDeltaFailuresNeverDowngrade(t *testing.T) {
	for _, scenario := range []struct {
		name    string
		service string
		code    string
	}{
		{"conflict", "agent-acp-service", "configuration_conflict"},
		{"invalid", "agent-acp-service", "invalid_execution_configuration"},
		{"unavailable", "agent-acp-service", "configuration_unavailable"},
		{"foreign base mismatch", "agent-controller", "configuration_base_mismatch"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			source := executionSource(t)
			remote := currentV2Digest(t, source)
			remote.Revision = source.Revision - 1
			store, client, _, stages := newV2PublicationFixture(t, remote)
			failure := &ports.DependencyError{Service: scenario.service, Code: scenario.code, Retryable: scenario.code == "configuration_unavailable"}
			client.delta = func(context.Context, ports.ExecutionDelta) (ports.ExecutionAcknowledgement, error) {
				*stages = append(*stages, "delta")
				return ports.ExecutionAcknowledgement{}, failure
			}
			_, err := v2Publisher(store, &executionCredentialOpener{}, client).Publish(t.Context(), "org-1")
			require.ErrorIs(t, err, error(failure))
			require.Equal(t, []string{"sync", "digest", "read", "delta"}, *stages)
		})
	}
}

func TestExecutionPublisherV2SettlementReadsSourceAndPublishesClosure(t *testing.T) {
	source := executionSource(t)
	source.Agents[0].Agent.ActiveOperationRequestID = "operation-close"
	remote := currentV2Digest(t, source)
	store, client, _, stages := newV2PublicationFixture(t, remote)
	store.read = func(context.Context, string) (ports.ExecutionSource, error) {
		*stages = append(*stages, "read")
		return source, nil
	}
	publisher := v2Publisher(store, &executionCredentialOpener{}, client)
	settlement := ports.LifecycleSettlementRequest{OrganizationID: "org-1", AgentID: "agent-1", OperationID: "operation-close", Mode: "wait"}
	_, err := publisher.publish(t.Context(), "org-1", &settlement)
	require.NoError(t, err)
	require.Equal(t, []string{"read", "digest", "record"}, *stages, "settlement validates the operation before reusing the acknowledged closure")
	*stages = nil
	stale := settlement
	stale.OperationID = "operation-stale"
	_, err = publisher.publish(t.Context(), "org-1", &stale)
	require.ErrorIs(t, err, ports.ErrConcurrentChange)
	require.Equal(t, []string{"read"}, *stages)
}

func TestExecutionPublisherV2RequiresAnExecutionV2Client(t *testing.T) {
	store := &executionPublicationStoreStub{
		synchronization: func(context.Context, string) (ports.ExecutionSynchronization, error) {
			return ports.ExecutionSynchronization{OrganizationID: "org-1", Revision: 3}, nil
		},
	}
	legacyOnly := NewExecutionPublisher(store, &executionCredentialOpener{}, &executionPublicationClientStub{}, WithExecutionWireVersion(2))
	_, err := legacyOnly.Publish(t.Context(), "org-1")
	require.ErrorIs(t, err, ports.ErrInvalidExecutionConfiguration)
}

func TestExecutionPublisherV2RejectsMalformedRemoteDigest(t *testing.T) {
	hex := strings.Repeat("a", 64)
	for _, remote := range []ports.ExecutionDigest{
		{OrganizationID: "org-2", SchemaVersion: 2, Revision: 3, Digest: &hex,
			Providers: []ports.ExecutionDigestEntry{}, Models: []ports.ExecutionDigestEntry{}, Agents: []ports.ExecutionDigestEntry{}},
		{OrganizationID: "org-1", SchemaVersion: 3, Revision: 3, Digest: &hex,
			Providers: []ports.ExecutionDigestEntry{}, Models: []ports.ExecutionDigestEntry{}, Agents: []ports.ExecutionDigestEntry{}},
		{OrganizationID: "org-1", SchemaVersion: 0, Revision: 4, Digest: nil,
			Providers: []ports.ExecutionDigestEntry{}, Models: []ports.ExecutionDigestEntry{}, Agents: []ports.ExecutionDigestEntry{}},
	} {
		store, client, _, stages := newV2PublicationFixture(t, remote)
		_, err := v2Publisher(store, &executionCredentialOpener{}, client).Publish(t.Context(), "org-1")
		var dependency *ports.DependencyError
		require.ErrorAs(t, err, &dependency)
		require.Equal(t, "invalid_response", dependency.Code)
		require.Equal(t, []string{"sync", "digest"}, *stages)
	}
}

func TestExecutionPublisherV2RejectsUnsafeSynchronizationRevision(t *testing.T) {
	remote := ports.ExecutionDigest{OrganizationID: "org-1", SchemaVersion: 0, Revision: 0,
		Providers: []ports.ExecutionDigestEntry{}, Models: []ports.ExecutionDigestEntry{}, Agents: []ports.ExecutionDigestEntry{}}
	_, client, _, _ := newV2PublicationFixture(t, remote)
	publisher := v2Publisher(&executionPublicationStoreStub{
		synchronization: func(context.Context, string) (ports.ExecutionSynchronization, error) {
			return ports.ExecutionSynchronization{OrganizationID: "org-1", Revision: ports.MaximumExecutionRevision + 1}, nil
		},
	}, &executionCredentialOpener{}, client)
	_, err := publisher.Publish(t.Context(), "org-1")
	require.ErrorIs(t, err, ports.ErrInvalidExecutionConfiguration)
}
