package directory

import (
	"context"
	"errors"
	"testing"
	"time"

	"soft/antnest-platform/services/identity-service/internal/domain"
)

func TestListPrincipalRevocationsValidatesBounds(t *testing.T) {
	for _, input := range []RevocationQuery{{AfterSequence: -1, Limit: 1}, {Limit: 0}, {Limit: 501}} {
		repository := &revocationRepositoryStub{}
		service := NewService(repository, func(kind string) string { return "id" }, time.Now)
		if _, err := service.ListPrincipalRevocations(t.Context(), input); !errors.Is(err, domain.ErrInvalidArgument) {
			t.Fatalf("query %#v: %v", input, err)
		}
		if repository.calls != 0 {
			t.Fatal("invalid query reached repository")
		}
	}
}

func TestListPrincipalRevocationsPreservesPageAndError(t *testing.T) {
	repository := &revocationRepositoryStub{page: domain.PrincipalRevocationPage{
		Events: []domain.PrincipalRevocation{{Sequence: 7, UserID: "owner"}}, NextSequence: 7,
	}}
	service := NewService(repository, func(kind string) string { return "id" }, time.Now)
	query := RevocationQuery{AfterSequence: 3, Limit: 1}
	page, err := service.ListPrincipalRevocations(t.Context(), query)
	if err != nil || page.NextSequence != 7 || len(page.Events) != 1 || repository.query != query {
		t.Fatalf("page=%#v query=%#v error=%v", page, repository.query, err)
	}
	repository.err = domain.ErrConflict
	if _, err := service.ListPrincipalRevocations(t.Context(), query); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("repository error lost: %v", err)
	}
}

type revocationRepositoryStub struct {
	directoryRepositoryStub
	calls int
	query RevocationQuery
	page  domain.PrincipalRevocationPage
	err   error
}

func (r *revocationRepositoryStub) ListPrincipalRevocations(_ context.Context, query RevocationQuery) (domain.PrincipalRevocationPage, error) {
	r.calls++
	r.query = query
	return r.page, r.err
}

func (*directoryRepositoryStub) ListPrincipalRevocations(context.Context, RevocationQuery) (domain.PrincipalRevocationPage, error) {
	return domain.PrincipalRevocationPage{}, nil
}

func (*directoryRepositoryStub) ResolveOwnerAuthorization(_ context.Context, userID, organizationID string) (domain.OwnerAuthorization, error) {
	return domain.OwnerAuthorization{UserID: userID, OrganizationID: organizationID}, nil
}

func TestOwnerAuthorizationRejectsMissingIdentity(t *testing.T) {
	service := NewService(&directoryRepositoryStub{}, func(kind string) string { return "id" }, time.Now)
	for _, pair := range [][2]string{{"", "org"}, {"user", ""}} {
		if _, err := service.ResolveOwnerAuthorization(t.Context(), pair[0], pair[1]); !errors.Is(err, domain.ErrInvalidArgument) {
			t.Fatalf("missing identity error=%v", err)
		}
	}
}
