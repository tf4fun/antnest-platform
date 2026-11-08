package registry

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"
)

type resourceIDVectors struct {
	Accept []string `json:"accept"`
	Reject []string `json:"reject"`
}

func TestResourceIDSharedVectors(t *testing.T) {
	data, err := os.ReadFile("../../../../contracts/common/id-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors map[string]resourceIDVectors
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	kinds := map[string]*regexp.Regexp{
		"organizationId": organizationID,
		"userId":         userID,
		"agentId":        agentID,
	}
	if len(vectors) != len(kinds) {
		t.Fatalf("vector kinds %v", vectors)
	}
	for kind, re := range kinds {
		v, ok := vectors[kind]
		if !ok {
			t.Fatalf("missing vectors for %s", kind)
		}
		for _, value := range v.Accept {
			if !re.MatchString(value) {
				t.Errorf("%s must accept %q", kind, value)
			}
		}
		for _, value := range v.Reject {
			if re.MatchString(value) {
				t.Errorf("%s must reject %q", kind, value)
			}
		}
	}
}

func TestResourceIDGeneratorFormatsUnchanged(t *testing.T) {
	id, err := newSkillID()
	if err != nil || !skillID.MatchString(id) {
		t.Fatalf("generated Skill ID changed format: %q %v", id, err)
	}
	for kind, re := range map[string]*regexp.Regexp{
		"organizationId": organizationID,
		"userId":         userID,
		"agentId":        agentID,
	} {
		for _, issued := range map[string][]string{
			"organizationId": {testOrg, testOther},
			"userId":         {testActor, testOtherActor},
			"agentId":        {testAgent},
		}[kind] {
			if !re.MatchString(issued) {
				t.Fatalf("already-issued %s %q rejected", kind, issued)
			}
		}
	}
}

func TestResourceIDProjectionAcceptsOpaqueIDsAndRejectsOutOfGrammar(t *testing.T) {
	d, store, index, source, _ := discoveryFixture(t)
	h := newTestHandler(t, NewService(store), d)
	put := func(body any, authenticate bool) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodPut, "/internal/skill-projections", bytes.NewReader(mustJSON(t, body)))
		if authenticate {
			h.Authenticate(req)
		}
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	if rec := put(source.current, false); rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated projection update: %d", rec.Code)
	}
	base := source.current
	for _, tc := range []struct {
		name              string
		org, agent, owner string
	}{
		{"non-prefix opaque IDs", "tenant.42", "Legacy.ID_9-z", "jdoe.1999"},
		{"boundary 200-byte IDs", strings.Repeat("a", 200), strings.Repeat("b", 200), strings.Repeat("c", 200)},
		{"recorded Controller Agent", testOrg, "agent_e94c17c429dc4904d167d643309872e5", testActor},
	} {
		p := base
		p.OrganizationID, p.AgentID, p.OwnerID = tc.org, tc.agent, tc.owner
		if rec := put(p, true); rec.Code != http.StatusOK {
			t.Fatalf("%s rejected: %d %s", tc.name, rec.Code, rec.Body.String())
		}
		stored, err := index.GetProjection(context.Background(), tc.org, tc.agent, p.Name)
		if err != nil || stored != p {
			t.Fatalf("%s not stored verbatim: %+v %v", tc.name, stored, err)
		}
	}
	before := len(index.values)
	for _, tc := range []struct {
		name  string
		field string
		value string
	}{
		{"empty organization", "organization_id", ""},
		{"separator organization", "organization_id", "a:b"},
		{"leading punctuation organization", "organization_id", "_a"},
		{"oversize organization", "organization_id", strings.Repeat("a", 201)},
		{"spaced agent", "agent_id", "a b"},
		{"slash agent", "agent_id", "a/b"},
		{"trailing newline owner", "owner_id", "a\n"},
		{"non-ASCII owner", "owner_id", "é"},
	} {
		p := base
		switch tc.field {
		case "organization_id":
			p.OrganizationID = tc.value
		case "agent_id":
			p.AgentID = tc.value
		case "owner_id":
			p.OwnerID = tc.value
		}
		if rec := put(p, true); rec.Code != http.StatusBadRequest {
			t.Fatalf("%s accepted: %d %s", tc.name, rec.Code, rec.Body.String())
		}
	}
	if len(index.values) != before {
		t.Fatal("rejected projection reached the store")
	}
}
