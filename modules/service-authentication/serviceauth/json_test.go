package serviceauth

import "testing"

func TestJSONObjectRejectsCaseFoldedFieldAliases(t *testing.T) {
	var target struct {
		Actor string `json:"actor_principal_id"`
	}
	for _, raw := range []string{`{"ACTOR_PRINCIPAL_ID":"victim"}`, `{"actor_principal_id":"admin","ACTOR_PRINCIPAL_ID":"victim"}`} {
		if DecodeObject([]byte(raw), &target) == nil {
			t.Fatal("case-insensitive Go field alias escaped the exact JSON contract")
		}
	}
}
