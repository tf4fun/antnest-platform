package scim

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

func TestSCIMLifecycleTokenAlwaysProjectsMetadata(t *testing.T) {
	raw, err := json.Marshal(Token{ID: "token-1", OrganizationID: "org-1"})
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"expires_at", "issued_by", "issuer_review_required"} {
		if _, ok := fields[name]; !ok {
			t.Errorf("required lifecycle metadata %q is missing", name)
		}
	}
}

func TestSCIMLifecycleServiceAppliesDefaultAndBoundsBeforeIssuance(t *testing.T) {
	for _, value := range []int{-1, 0, 1, 90, 365, 366} {
		t.Run(fmt.Sprint(value), func(t *testing.T) {
			repo := &scimRepositoryStub{principal: scimAdmin()}
			service := newSCIMTestService(t, repo)
			_, err := service.IssueToken(t.Context(), IssueTokenInput{RequestID: "ttl", ActorPrincipalID: "admin", OrganizationID: "org-1",
				Name: "Directory", Scopes: []string{domain.SCIMScopeWrite}, ExpiresInDays: &value})
			if value < 1 || value > 365 {
				if !errors.Is(err, domain.ErrInvalidArgument) || repo.issued.TokenID != "" {
					t.Fatalf("invalid TTL reached repository: err=%v command=%+v", err, repo.issued)
				}
			} else if err != nil || repo.issued.ExpiresInDays != value {
				t.Fatalf("TTL not forwarded: days=%d err=%v", repo.issued.ExpiresInDays, err)
			}
		})
	}
	t.Run("omitted", func(t *testing.T) {
		repo := &scimRepositoryStub{principal: scimAdmin()}
		_, err := newSCIMTestService(t, repo).IssueToken(t.Context(), IssueTokenInput{RequestID: "ttl", ActorPrincipalID: "admin", OrganizationID: "org-1", Name: "Directory", Scopes: []string{domain.SCIMScopeRead}})
		if err != nil || repo.issued.ExpiresInDays != 90 {
			t.Fatalf("omitted TTL=%d err=%v", repo.issued.ExpiresInDays, err)
		}
	})
}
