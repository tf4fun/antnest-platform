package principal

import (
	"net/http"
	"testing"
)

func TestFromHeadersRequiresCompleteAdministratorProjection(t *testing.T) {
	header := make(http.Header)
	header.Set(HeaderUserID, "user-1")
	header.Set(HeaderOrganizationID, "org-1")
	header.Set(HeaderMembershipID, "membership-1")
	header.Set(HeaderSystemRole, "admin")
	header.Set(HeaderOrganizationRole, "admin")
	result, err := FromHeaders(header)
	if err != nil || !result.Administrator() || result.OrganizationID != "org-1" {
		t.Fatalf("principal=%#v err=%v", result, err)
	}
	header.Del(HeaderMembershipID)
	if _, err := FromHeaders(header); err == nil {
		t.Fatal("incomplete principal was accepted")
	}
}
