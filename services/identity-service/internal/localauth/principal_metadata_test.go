package localauth

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

func TestLocalAuthPreservesOrganizationMetadata(t *testing.T) {
	t.Parallel()
	var expected domain.Principal
	if err := json.Unmarshal([]byte(`{"user_id":"user-1","organization_id":"org-1","organization_slug":"engineering","organization_name":"Engineering","membership_id":"member-1","system_role":"user","organization_role":"member","active":true}`), &expected); err != nil {
		t.Fatal(err)
	}
	hash, err := credentials.HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	repository := &authRepositoryStub{credential: LocalCredential{PasswordHash: hash, Principal: expected}, resolved: expected}
	service, err := NewService(repository, sequentialIDs(), fixedNow, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	login, err := service.Login(t.Context(), LoginInput{
		RequestID: "metadata-login", OrganizationSlug: "engineering", Email: "member@example.com", Password: "correct horse battery staple",
	})
	if err != nil {
		t.Fatal(err)
	}
	resolved, err := service.Resolve(t.Context(), login.AccessToken)
	if err != nil {
		t.Fatal(err)
	}
	for _, principal := range []domain.Principal{login.Principal, repository.issued.Principal, resolved} {
		encoded, err := json.Marshal(principal)
		if err != nil {
			t.Fatal(err)
		}
		var value map[string]any
		if err := json.Unmarshal(encoded, &value); err != nil {
			t.Fatal(err)
		}
		if value["organization_slug"] != "engineering" || value["organization_name"] != "Engineering" {
			t.Fatalf("login/issuance/resolve dropped organization metadata: %s", encoded)
		}
	}
}
