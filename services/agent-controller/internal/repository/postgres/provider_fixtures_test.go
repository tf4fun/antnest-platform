package postgres

import (
	"context"
	"strings"
	"testing"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func seedProviderForModel(t *testing.T, repository *Repository, model ports.ModelProfileRecord) {
	t.Helper()
	_, err := repository.PutProviderConnection(context.Background(), ports.ProviderConnectionRecord{
		RequestID: "provider-" + model.RequestID, RequestFingerprint: strings.Repeat("a", 64),
		ConnectionID: model.ProviderConnectionID, OrganizationID: model.OrganizationID,
		ProviderKey: "deepseek", DisplayName: "Provider", BaseURL: model.Revision.Snapshot().Model.BaseURL,
		CredentialMethod: "api_key", CredentialVersion: "version-" + model.ProviderConnectionID, CredentialRevision: 1,
		SealedCredential: ports.SealedSecret{Ciphertext: []byte("ciphertext"), Nonce: []byte("nonce")},
		Enabled:          true, CreatedAt: model.CreatedAt, UpdatedAt: model.UpdatedAt,
	}, nil)
	if err != nil {
		t.Fatalf("seed model Provider: %v", err)
	}
}
