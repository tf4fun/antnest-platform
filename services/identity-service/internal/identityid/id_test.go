package identityid

import (
	"regexp"
	"testing"
)

func TestNewProducesTypedDistinctIDs(t *testing.T) {
	seen := map[string]bool{}
	for _, kind := range []string{"org", "user", "membership", "group", "groupmembership", "oidcprovider", "oidcsession", "oidcclaim", "externalidentity", "authtoken", "scimtoken", "event"} {
		pattern := regexp.MustCompile("^" + kind + "_[0-9a-f]{32}$")
		for range 4 {
			id, err := New(kind)
			if err != nil || !pattern.MatchString(id) || seen[id] {
				t.Fatalf("new %s ID = %q, %v; duplicate=%v", kind, id, err, seen[id])
			}
			seen[id] = true
		}
		if id := MustNew(kind); !pattern.MatchString(id) {
			t.Fatalf("MustNew(%q) = %q", kind, id)
		}
	}
}

func TestNewRejectsUnregisteredResourceKind(t *testing.T) {
	for _, kind := range []string{"", "id", "User", "user_", "other"} {
		if id, err := New(kind); err == nil || id != "" {
			t.Fatalf("New(%q) = %q, %v", kind, id, err)
		}
	}
}
