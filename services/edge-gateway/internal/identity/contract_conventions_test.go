package identity

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestContractConventionsPageSerialization(t *testing.T) {
	for _, test := range []struct {
		name string
		page any
		want string
	}{
		{name: "sessions_terminal", page: SessionPage{Sessions: []BrowserSession{}}, want: `"next_cursor":null`},
		{name: "sessions_continuation", page: SessionPage{Sessions: []BrowserSession{}, NextAfterID: "public-next"}, want: `"next_cursor":"public-next"`},
		{name: "bindings_terminal", page: ExternalIdentityPage{Bindings: []ExternalIdentity{}, Notices: []ExternalIdentityNotice{}}, want: `"next_cursor":null`},
		{name: "bindings_continuation", page: ExternalIdentityPage{Bindings: []ExternalIdentity{}, Notices: []ExternalIdentityNotice{}, NextAfterID: "public-next"}, want: `"next_cursor":"public-next"`},
	} {
		t.Run(test.name, func(t *testing.T) {
			data, err := json.Marshal(test.page)
			if err != nil {
				t.Fatal(err)
			}
			var document map[string]any
			if err := json.Unmarshal(data, &document); err != nil {
				t.Fatal(err)
			}
			if _, ok := document["items"]; !ok {
				t.Fatalf("missing items: %s", data)
			}
			if _, ok := document["next_cursor"]; !ok || !strings.Contains(string(data), test.want) {
				t.Fatalf("next_cursor wrong: %s", data)
			}
			for _, banned := range []string{"sessions", "bindings", "next_after_id"} {
				if _, ok := document[banned]; ok {
					t.Fatalf("legacy field %s emitted: %s", banned, data)
				}
			}
		})
	}
	page := ExternalIdentityPage{Bindings: []ExternalIdentity{}, Notices: []ExternalIdentityNotice{{ID: "notice-1"}}, NextNoticeAfterID: "notice-next"}
	data, err := json.Marshal(page)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	if _, ok := document["notices"]; !ok {
		t.Fatalf("notices missing: %s", data)
	}
	if document["next_notice_after_id"] != "notice-next" {
		t.Fatalf("notice cursor=%v body=%s", document["next_notice_after_id"], data)
	}
}
