package directory

import (
	"context"
	"strings"

	"soft/antnest-platform/services/identity-service/internal/domain"
)

type RevocationQuery struct {
	AfterSequence int64
	Limit         int
}

func (s *Service) ResolveOwnerAuthorization(ctx context.Context, userID, organizationID string) (domain.OwnerAuthorization, error) {
	userID, organizationID = strings.TrimSpace(userID), strings.TrimSpace(organizationID)
	if userID == "" || organizationID == "" {
		return domain.OwnerAuthorization{}, domain.InvalidArgument("user_id and organization_id are required")
	}
	return s.repository.ResolveOwnerAuthorization(ctx, userID, organizationID)
}

func (s *Service) ListPrincipalRevocations(ctx context.Context, query RevocationQuery) (domain.PrincipalRevocationPage, error) {
	if query.AfterSequence < 0 || query.Limit < 1 || query.Limit > 500 {
		return domain.PrincipalRevocationPage{}, domain.InvalidArgument("after_sequence must be nonnegative and limit must be between 1 and 500")
	}
	return s.repository.ListPrincipalRevocations(ctx, query)
}
