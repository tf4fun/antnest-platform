package scim

import "github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"

// TokenLifetimeDays distinguishes an omitted TTL from an explicit invalid zero.
func TokenLifetimeDays(requested *int) (int, error) {
	if requested == nil {
		return 90, nil
	}
	if *requested < 1 || *requested > 365 {
		return 0, domain.InvalidArgument("expires_in_days must be an integer from 1 to 365")
	}
	return *requested, nil
}
