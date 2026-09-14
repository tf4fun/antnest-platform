package principal

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
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

func TestTrustedPrincipalContextAndHeaderRoundTrip(t *testing.T) {
	t.Parallel()
	actor := Principal{UserID: "User Oncall:+ops@example", OrganizationID: "org.prod", MembershipID: "member/42",
		SystemRole: "user", OrganizationRole: "admin"}
	header, err := actor.Headers()
	require.NoError(t, err)
	parsed, err := FromHeaders(header)
	require.NoError(t, err)
	require.Equal(t, actor, parsed)
	stored, ok := FromContext(WithContext(t.Context(), parsed))
	require.True(t, ok)
	require.Equal(t, actor, stored)
	_, ok = FromContext(context.Background())
	require.False(t, ok)
	require.Len(t, header, 5)
}

func TestTrustedPrincipalRejectsAmbiguousHeadersAndUnknownRoles(t *testing.T) {
	t.Parallel()
	actor := Principal{UserID: "user-1", OrganizationID: "org-1", MembershipID: "member-1", SystemRole: "admin", OrganizationRole: "member"}
	for _, test := range []struct{ key, value string }{
		{HeaderUserID, "user-1,user-2"}, {HeaderOrganizationID, "org-1\t"},
		{HeaderSystemRole, "root"}, {HeaderOrganizationRole, "owner"},
	} {
		header, err := actor.Headers()
		require.NoError(t, err)
		header.Set(test.key, test.value)
		_, err = FromHeaders(header)
		require.Error(t, err)
	}
	header, err := actor.Headers()
	require.NoError(t, err)
	header.Add(HeaderMembershipID, "member-2")
	_, err = FromHeaders(header)
	require.Error(t, err)
}
