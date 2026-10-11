package oidcflow

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestSubjectJSONPreservesScalarsAndLiteralEscapes(t *testing.T) {
	for _, value := range []string{" exact:subject|1 ", "\ufffd", `literal\uD800`, strings.Repeat("界", 255), strings.Repeat("🙂", 255)} {
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		got, err := ParseSubjectJSON(raw)
		if err != nil || got != value {
			t.Fatalf("subject changed during decoding: %v", err)
		}
	}
	if got, err := ParseSubjectJSON([]byte(`"\ud83d\ude42"`)); err != nil || got != "🙂" {
		t.Fatalf("valid surrogate pair rejected: %q %v", got, err)
	}
	for _, raw := range []string{`null`, `0`, `{}`, `[]`, `""`, `"\ud800"`, `"\udc00"`, `"\ud800x"`, `"\ud800\u0001"`, `"\u0000"`, "\"\xff\"", `"\u"`, `"x" "y"`} {
		if _, err := ParseSubjectJSON([]byte(raw)); err == nil {
			t.Errorf("invalid raw subject accepted: %s", raw)
		}
	}
}
