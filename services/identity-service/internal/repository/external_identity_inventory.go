package repository

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/externalidentities"
)

func (a *ExternalIdentitiesAdapter) List(ctx context.Context, access externalidentities.Access, input externalidentities.ListInput) (externalidentities.Page, error) {
	page := externalidentities.Page{Bindings: []externalidentities.Binding{}}
	err := a.store.inTransaction(ctx, func(tx *databaseTransaction) error {
		live, err := a.store.authorizeExternalAccess(ctx, tx, access)
		if err != nil {
			return err
		}
		userID, organizationID, membershipID := live.Principal.UserID, "", ""
		if access.Scope == "organization" {
			organizationID, membershipID = live.Principal.OrganizationID, input.MembershipID
			if err := tx.QueryRow(ctx, `SELECT user_id FROM organization_memberships WHERE id=$1 AND organization_id=$2`, membershipID, organizationID).Scan(&userID); err != nil {
				return err
			}
		}
		rows, err := tx.Query(ctx, bindingSelect+` WHERE e.user_id=$1 AND ($2='' OR e.organization_id=$2) AND ($3='' OR e.membership_id=$3) AND e.id>$4 ORDER BY e.id LIMIT $5`, userID, organizationID, membershipID, input.AfterID, input.Limit+1)
		if err != nil {
			return err
		}
		bindings, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (externalidentities.Binding, error) { return scanBinding(row) })
		if err != nil {
			return err
		}
		if len(bindings) > input.Limit {
			bindings = bindings[:input.Limit]
			page.NextAfterID = bindings[len(bindings)-1].ID
		}
		page.Bindings = append(page.Bindings, bindings...)
		if access.Scope == "self" {
			notices := []externalidentities.Notice{}
			rows, err := tx.Query(ctx, `SELECT id,binding_id,provider_id,provider_name,provider_display_name,organization_id,organization_slug,organization_name,membership_id,subject,method,created_at
				FROM external_identity_notices WHERE user_id=$1 AND acknowledged_at IS NULL AND id>$2 ORDER BY id LIMIT $3`, userID, input.NoticeAfterID, input.Limit+1)
			if err != nil {
				return err
			}
			items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (externalidentities.Notice, error) {
				var n externalidentities.Notice
				err := row.Scan(&n.ID, &n.BindingID, &n.ProviderID, &n.ProviderName, &n.ProviderDisplayName, &n.OrganizationID, &n.OrganizationSlug, &n.OrganizationName, &n.MembershipID, &n.Subject, &n.Method, &n.CreatedAt)
				n.CreatedAt = n.CreatedAt.UTC()
				return n, err
			})
			if err != nil {
				return err
			}
			if len(items) > input.Limit {
				items = items[:input.Limit]
				page.NextNoticeAfterID = items[len(items)-1].ID
			}
			notices = append(notices, items...)
			page.Notices = &notices
		}
		_, err = a.store.authorizeExternalAccess(ctx, tx, access)
		return err
	})
	if err != nil {
		return externalidentities.Page{}, err
	}
	return page, nil
}

func (a *ExternalIdentitiesAdapter) ListProviders(ctx context.Context, access externalidentities.Access, input externalidentities.ProvidersInput) (externalidentities.ProvidersPage, error) {
	page := externalidentities.ProvidersPage{Providers: []externalidentities.Provider{}}
	err := a.store.inTransaction(ctx, func(tx *databaseTransaction) error {
		live, err := a.store.authorizeExternalAccess(ctx, tx, access)
		if err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `SELECT id,name,display_name,enabled,link_policy,link_domains,authoritative,link_policy_review_required FROM oidc_providers
			WHERE organization_id=$1 AND id>$2 ORDER BY id LIMIT $3`, live.Principal.OrganizationID, input.AfterID, input.Limit+1)
		if err != nil {
			return err
		}
		items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (externalidentities.Provider, error) {
			var p externalidentities.Provider
			err := row.Scan(&p.ID, &p.Name, &p.DisplayName, &p.Enabled, &p.LinkPolicy, &p.LinkDomains, &p.Authoritative, &p.LinkPolicyReviewRequired)
			return p, err
		})
		if err != nil {
			return err
		}
		if len(items) > input.Limit {
			items = items[:input.Limit]
			page.NextAfterID = items[len(items)-1].ID
		}
		page.Providers = append(page.Providers, items...)
		_, err = a.store.authorizeExternalAccess(ctx, tx, access)
		return err
	})
	if err != nil {
		return externalidentities.ProvidersPage{}, err
	}
	return page, nil
}
