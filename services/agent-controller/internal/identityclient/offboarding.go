package identityclient

import (
	"context"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type ownerRequest struct {
	UserID         string `json:"user_id"`
	OrganizationID string `json:"organization_id"`
}

type principalWire struct {
	UserID         string `json:"user_id"`
	OrganizationID string `json:"organization_id"`
	MembershipID   string `json:"membership_id"`
	Active         *bool  `json:"active"`
}

func (wire principalWire) matches(organizationID, userID string) bool {
	return wire.UserID == userID && wire.OrganizationID == organizationID &&
		identityIDPattern.MatchString(wire.MembershipID) && wire.Active != nil
}

func (wire principalWire) principal() ports.IdentityPrincipal {
	return ports.IdentityPrincipal{UserID: wire.UserID, OrganizationID: wire.OrganizationID,
		MembershipID: wire.MembershipID, Active: *wire.Active}
}

func (client *Client) ResolveOwnerAuthorization(
	ctx context.Context, organizationID, userID string,
) (result ports.IdentityPrincipal, resultErr error) {
	if !identityIDPattern.MatchString(organizationID) || !identityIDPattern.MatchString(userID) {
		return result, dependencyFailure("invalid_request", false)
	}
	err := client.invoke(ctx, "resolve_owner_authorization", "/rpc/identity/resolve-owner-authorization",
		ownerRequest{UserID: userID, OrganizationID: organizationID}, func(body []byte) error {
			var wire struct {
				Authorization struct {
					principalWire
					LastRevocationSequence *int64 `json:"last_revocation_sequence"`
				} `json:"authorization"`
			}
			if err := decodeStrictJSON(body, &wire); err != nil ||
				!wire.Authorization.matches(organizationID, userID) ||
				wire.Authorization.LastRevocationSequence == nil || *wire.Authorization.LastRevocationSequence < 0 {
				return dependencyFailure("invalid_response", true)
			}
			result = wire.Authorization.principal()
			result.LastRevocationSequence = *wire.Authorization.LastRevocationSequence
			return nil
		})
	return result, err
}

func (client *Client) ListPrincipalRevocations(
	ctx context.Context, after int64, limit int,
) (result ports.PrincipalRevocationPage, resultErr error) {
	if after < 0 || limit < 1 || limit > 500 {
		return result, dependencyFailure("invalid_request", false)
	}
	err := client.invoke(ctx, "list_principal_revocations", "/rpc/identity/list-principal-revocations", struct {
		After int64 `json:"after_sequence"`
		Limit int   `json:"limit"`
	}{after, limit}, func(body []byte) error {
		var wire struct {
			Events       *[]ports.PrincipalRevocation `json:"events"`
			NextSequence *int64                       `json:"next_sequence"`
		}
		if err := decodeStrictJSON(body, &wire); err != nil || wire.Events == nil || wire.NextSequence == nil {
			return dependencyFailure("invalid_response", true)
		}
		if !validRevocationPage(*wire.Events, after, *wire.NextSequence, limit) {
			return dependencyFailure("invalid_response", true)
		}
		result = ports.PrincipalRevocationPage{Events: *wire.Events, NextSequence: *wire.NextSequence}
		return nil
	})
	return result, err
}

func validRevocationPage(events []ports.PrincipalRevocation, after, next int64, limit int) bool {
	if len(events) > limit {
		return false
	}
	for _, event := range events {
		if event.Sequence <= after || !identityIDPattern.MatchString(event.UserID) || event.OccurredAt.IsZero() {
			return false
		}
		switch event.Reason {
		case "user_deactivated":
			if event.OrganizationID != "" {
				return false
			}
		case "membership_deactivated", "membership_deleted":
			if !identityIDPattern.MatchString(event.OrganizationID) {
				return false
			}
		default:
			return false
		}
		if event.TraceParent != "" {
			ctx := propagation.TraceContext{}.Extract(context.Background(), propagation.MapCarrier{"traceparent": event.TraceParent})
			if !trace.SpanContextFromContext(ctx).IsValid() {
				return false
			}
		}
		after = event.Sequence
	}
	return next == after
}
