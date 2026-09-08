package e2e

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"soft/antnest-platform/services/identity-service/internal/domain"
	"soft/antnest-platform/services/identity-service/internal/rpc"
	"soft/antnest-platform/services/identity-service/internal/scim"
)

func assertSCIMRevocationDelivery(t *testing.T, identity *httptest.Server, credential string, user scim.UserResource) {
	t.Helper()
	endpoint := identity.URL + "/scim/v2/Users/" + user.Membership.ID
	scimRequest(t, identity.Client(), http.MethodPatch, endpoint, credential, map[string]any{
		"schemas":    []string{"urn:ietf:params:scim:api:messages:2.0:PatchOp"},
		"Operations": []map[string]any{{"op": "replace", "path": "active", "value": false}},
	}, http.StatusOK, &map[string]any{})
	var page domain.PrincipalRevocationPage
	feedURL := identity.URL + rpc.ContractRoutes["list_principal_revocations"]
	postJSON(t, identity.Client(), feedURL, map[string]any{"after_sequence": 0, "limit": 1}, &page)
	if len(page.Events) != 1 || page.Events[0].UserID != user.User.ID ||
		page.Events[0].OrganizationID != user.Membership.OrganizationID || page.Events[0].Reason != "membership_deactivated" {
		t.Fatalf("SCIM -> revocation RPC: %#v", page)
	}
	previous := page.NextSequence
	scimRequest(t, identity.Client(), http.MethodDelete, endpoint, credential, nil, http.StatusNoContent, nil)
	postJSON(t, identity.Client(), feedURL, map[string]any{"after_sequence": previous, "limit": 500}, &page)
	if len(page.Events) != 1 || page.Events[0].Reason != "membership_deleted" || page.NextSequence <= previous {
		t.Fatalf("SCIM deletion after inactive -> revocation RPC: %#v", page)
	}
}
