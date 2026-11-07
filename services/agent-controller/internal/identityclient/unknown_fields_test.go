package identityclient

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestResolvePrincipalToleratesUnknownResponseFields(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"principal":{"user_id":"user-1","organization_id":"org-1","membership_id":"membership-1","active":true,"system_role":"user","future_extension":{"nested":[1,2]}},"future_top":{"cursor":"opaque"}}`))
	}))
	defer server.Close()

	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	principal, err := client.ResolvePrincipal(context.Background(), "org-1", "user-1")
	if err != nil {
		t.Fatalf("resolve principal: %v", err)
	}
	if principal.UserID != "user-1" || principal.OrganizationID != "org-1" ||
		principal.MembershipID != "membership-1" || !principal.Active {
		t.Fatalf("principal = %#v", principal)
	}
}
