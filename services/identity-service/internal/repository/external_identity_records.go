package repository

import (
	"context"
	"time"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/externalidentities"
)

const bindingSelect = `SELECT e.id, e.provider_id, p.name, p.display_name,
	e.organization_id, o.slug, o.name, e.membership_id, e.subject, e.method,
	p.enabled, e.created_at, e.bound_at, e.revoked_at
	FROM external_identities e JOIN oidc_providers p ON p.id=e.provider_id
	JOIN organizations o ON o.id=e.organization_id`

func scanBinding(row rowScanner) (externalidentities.Binding, error) {
	var b externalidentities.Binding
	err := row.Scan(&b.ID, &b.ProviderID, &b.ProviderName, &b.ProviderDisplayName, &b.OrganizationID, &b.OrganizationSlug, &b.OrganizationName, &b.MembershipID, &b.Subject, &b.Method, &b.ProviderEnabled, &b.CreatedAt, &b.BoundAt, &b.RevokedAt)
	b.CreatedAt, b.BoundAt = b.CreatedAt.UTC(), b.BoundAt.UTC()
	if b.RevokedAt != nil {
		v := b.RevokedAt.UTC()
		b.RevokedAt = &v
	}
	return b, err
}

func (s *Store) recordExternalIdentityBound(ctx context.Context, tx *databaseTransaction, bindingID, userID, actorID, scimTokenID, requestID string, now time.Time) error {
	binding, err := scanBinding(tx.QueryRow(ctx, bindingSelect+` WHERE e.id=$1`, bindingID))
	if err != nil {
		return err
	}
	if err := s.appendEvent(ctx, tx, event{OrganizationID: binding.OrganizationID, ActorPrincipalID: actorID, ActorSCIMTokenID: scimTokenID, Type: "external_identity.bound", SubjectType: "external_identity", SubjectID: binding.ID, RequestID: requestID, CreatedAt: now, Metadata: map[string]any{"provider_id": binding.ProviderID, "membership_id": binding.MembershipID, "method": binding.Method}}); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO external_identity_notices
		(id,user_id,binding_id,provider_id,provider_name,provider_display_name,organization_id,organization_slug,organization_name,membership_id,subject,method,created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
		s.newID("externalidentitynotice"), userID, binding.ID, binding.ProviderID, binding.ProviderName, binding.ProviderDisplayName, binding.OrganizationID, binding.OrganizationSlug, binding.OrganizationName, binding.MembershipID, binding.Subject, binding.Method, now)
	return err
}
