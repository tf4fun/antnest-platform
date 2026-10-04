package registry

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/skill-registry/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/skill-registry/internal/serviceauth"
)

func TestRegistryEveryCallerDeniedOutsideItsCatalogRow(t *testing.T) {
	data, err := os.ReadFile("../../../../contracts/skill-registry/callers.json")
	if err != nil {
		t.Fatal(err)
	}
	var catalog struct {
		Routes map[string]struct {
			Callers        []string `json:"callers"`
			Authentication string   `json:"authentication"`
		} `json:"routes"`
	}
	if err := json.Unmarshal(data, &catalog); err != nil {
		t.Fatal(err)
	}
	for pattern, policy := range catalog.Routes {
		if policy.Authentication != "workload" {
			continue
		}
		for _, caller := range serviceauth.Services {
			if caller == "skill-registry" {
				continue
			}
			t.Run(pattern+"/"+caller, func(t *testing.T) {
				d, store, _, source, load := discoveryFixture(t)
				service := NewService(store)
				version, err := service.Publish(t.Context(), PublishInput{RequestID: "seed", OrganizationID: testOrg, ActorID: testActor, Artifact: source.archive})
				if err != nil {
					t.Fatal(err)
				}
				h := newTestHandler(t, service, d)
				method, path, _ := strings.Cut(pattern, " ")
				path = strings.ReplaceAll(path, "{skill_id}", version.SkillID)
				path = strings.ReplaceAll(path, "{version}", "1")
				var req *http.Request
				if strings.HasPrefix(pattern, "POST /internal/skills") {
					meta := map[string]any{"request_id": "matrix-publish", "organization_id": testOrg, "actor_id": testActor}
					archive := skillZIP(t, "---\nname: another-skill\ndescription: Another skill\n---\n")
					if strings.Contains(pattern, "versions") {
						meta["expected_version"] = 1
						archive = source.archive
					}
					req = publishRequest(t, meta, archive)
					req.URL.Path = path
				} else {
					var input any
					switch path {
					case "/internal/skill-versions/resolve":
						input = map[string]any{"organization_id": testOrg, "refs": []Reference{{SkillID: version.SkillID, Version: 1}}}
					case "/internal/skill-projections":
						input = source.current
					case "/internal/skill-discovery/search":
						input = SearchInput{OrganizationID: testOrg, ActorID: testActor, Query: "review"}
					case "/internal/skill-discovery/load":
						input = load
					case "/internal/skill-projections/promote":
						input = PromoteInput{RequestID: "matrix-promote", OrganizationID: testOrg, ActorID: testActor, SkillRef: load.SkillRef, ExpectedDigest: load.ExpectedDigest, SkillID: version.SkillID, ExpectedVersion: 1}
					}
					if method == "GET" {
						path += "?organization_id=" + testOrg
					}
					req = httptest.NewRequest(method, path, bytes.NewReader(mustJSON(t, input)))
					req.Header.Set("Content-Type", "application/json")
				}
				h.Authorize(req, caller)
				response := httptest.NewRecorder()
				h.ServeHTTP(response, req)
				if !slices.Contains(policy.Callers, caller) {
					if response.Code != 403 || !strings.Contains(response.Body.String(), "caller_not_allowed") || response.Header().Get("WWW-Authenticate") != "" {
						t.Fatalf("forbidden route admitted: %d %s", response.Code, response.Body.String())
					}
				} else if response.Code != 200 && response.Code != 201 {
					t.Fatalf("allowed operation failed: %d %s", response.Code, response.Body.String())
				}
			})
		}
	}
}

func TestConsoleVerifiedScopeAndRoleRejectBeforePublicationOrReplay(t *testing.T) {
	for _, tc := range []struct {
		name, org, actor, code string
		claims                 map[string]any
		status                 int
	}{
		{"organization", testOther, testActor, "organization_mismatch", nil, 403},
		{"actor", testOrg, "user_00000000000000000000000000000002", "actor_mismatch", nil, 403},
		{"member", testOrg, testActor, "forbidden", map[string]any{"sys_role": "user", "org_role": "member"}, 403},
		{"Agent-scoped", testOrg, testActor, "caller_context_invalid", map[string]any{"agt": testAgent}, 401},
		{"wrong audience", testOrg, testActor, "caller_context_invalid", map[string]any{"aud": []string{"admin-console"}}, 401},
		{"expired", testOrg, testActor, "caller_context_invalid", map[string]any{"iat": 1, "exp": 61}, 401},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &memoryStore{}
			h := newTestHandler(t, NewService(store))
			req := publishRequest(t, map[string]any{"request_id": "scope-replay", "organization_id": tc.org, "actor_id": tc.actor}, skillZIP(t, "---\nname: review\ndescription: Review\n---\n"))
			h.Authorize(req, "admin-console")
			req.Header.Set(callercontext.Header, h.contextToken(tc.claims))
			response := httptest.NewRecorder()
			h.ServeHTTP(response, req)
			if response.Code != tc.status || !strings.Contains(response.Body.String(), tc.code) || len(store.items) != 0 || len(store.receipts) != 0 {
				t.Fatalf("scope/role effect: %d %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestConsolePromoteCannotSupplyAnotherActorOrOrganization(t *testing.T) {
	for _, field := range []string{"organization_id", "actor_id"} {
		t.Run(field, func(t *testing.T) {
			d, store, _, _, load := discoveryFixture(t)
			h := newTestHandler(t, NewService(store), d)
			in := map[string]any{"request_id": "promote-actor", "organization_id": testOrg, "actor_id": testActor, "skill_ref": load.SkillRef, "expected_digest": load.ExpectedDigest}
			in[field] = testOther
			if field == "actor_id" {
				in[field] = "user_00000000000000000000000000000002"
			}
			req := httptest.NewRequest("POST", "/internal/skill-projections/promote", bytes.NewReader(mustJSON(t, in)))
			req.Header.Set("Content-Type", "application/json")
			h.Authorize(req, "admin-console")
			response := httptest.NewRecorder()
			h.ServeHTTP(response, req)
			if response.Code != 403 || len(store.receipts) != 0 {
				t.Fatalf("forged promotion effect: %d", response.Code)
			}
		})
	}
}

func TestJSONRoutesRejectMediaDuplicateMembersAndUntrustedAuthority(t *testing.T) {
	paths := []struct{ method, path, caller string }{{"POST", "/internal/skill-versions/resolve", "agent-controller"}, {"PUT", "/internal/skill-projections", "agent-acp-service"}, {"POST", "/internal/skill-discovery/search", "agent-acp-service"}, {"POST", "/internal/skill-discovery/load", "agent-acp-service"}, {"POST", "/internal/skill-projections/promote", "admin-console"}}
	for _, route := range paths {
		for _, media := range []string{"", "text/plain", "application/json; charset=latin1", "application/vnd.test+json", "application/json; extra=1"} {
			t.Run(route.path+media, func(t *testing.T) {
				d, store, _, _, _ := discoveryFixture(t)
				h := newTestHandler(t, NewService(store), d)
				req := httptest.NewRequest(route.method, route.path, strings.NewReader(`{}`))
				h.Authorize(req, route.caller)
				if media != "" {
					req.Header.Set("Content-Type", media)
				}
				response := httptest.NewRecorder()
				h.ServeHTTP(response, req)
				if response.Code != 415 {
					t.Fatalf("invalid media admitted: %d", response.Code)
				}
			})
		}
	}
	h := newTestHandler(t, NewService(&memoryStore{}))
	for _, body := range []string{`{"organization_id":"` + testOther + `","organization_id":"` + testOrg + `","refs":[]}`, `{"Organization_id":"` + testOrg + `","refs":[]}`, `{} {}`, `[]`} {
		req := httptest.NewRequest("POST", "/internal/skill-versions/resolve", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		h.Authorize(req, "agent-controller")
		response := httptest.NewRecorder()
		h.ServeHTTP(response, req)
		if response.Code != 400 {
			t.Fatalf("ambiguous JSON admitted: %d", response.Code)
		}
	}
}

func TestMultipartDuplicateMediaAndEncodingRejectedBeforePublish(t *testing.T) {
	for _, mutation := range []func(*http.Request){
		func(r *http.Request) { r.Header.Add("Content-Type", r.Header.Get("Content-Type")) },
		func(r *http.Request) { r.Header.Set("Content-Encoding", "gzip") },
	} {
		store := &memoryStore{}
		h := newTestHandler(t, NewService(store))
		req := publishRequest(t, map[string]any{"request_id": "multipart-ambiguity", "organization_id": testOrg, "actor_id": testActor}, skillZIP(t, "---\nname: review\ndescription: Review\n---\n"))
		h.Authorize(req, "admin-console")
		mutation(req)
		response := httptest.NewRecorder()
		h.ServeHTTP(response, req)
		if response.Code != 415 || len(store.receipts) != 0 {
			t.Fatalf("ambiguous multipart effects: %d", response.Code)
		}
	}
}
