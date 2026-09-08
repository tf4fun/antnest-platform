package directory

import (
	"context"

	"soft/antnest-platform/services/identity-service/internal/domain"
)

type RevocationQuery struct {
	AfterSequence int64
	Limit         int
}

func (s *Service) ListPrincipalRevocations(ctx context.Context, query RevocationQuery) (domain.PrincipalRevocationPage, error) {
	if query.AfterSequence < 0 || query.Limit < 1 || query.Limit > 500 {
		return domain.PrincipalRevocationPage{}, domain.InvalidArgument("after_sequence must be nonnegative and limit must be between 1 and 500")
	}
	return s.repository.ListPrincipalRevocations(ctx, query)
}
