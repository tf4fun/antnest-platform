package registry

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPostgresPublicationAndPromotionDeriveAuditActorFromVerifiedContext(t *testing.T) {
	pool := discoveryDatabase(t)
	if err := ApplyMigrations(t.Context(), pool); err != nil {
		t.Fatal(err)
	}
	store := NewPostgresStore(pool)
	service := NewService(store)
	_, _, _, source, load := discoveryFixture(t)
	d := NewDiscovery(service, store, source)
	if _, err := d.Update(t.Context(), source.current); err != nil {
		t.Fatal(err)
	}
	h := newTestHandler(t, service, d)
	req := publishRequest(t, map[string]any{"request_id": "verified-publish", "organization_id": testOrg, "actor_id": testActor}, source.archive)
	h.Authorize(req, "admin-console")
	req.Header.Set("X-Antnest-Principal-ID", "user-forged")
	response := httptest.NewRecorder()
	h.ServeHTTP(response, req)
	if response.Code != 201 {
		t.Fatalf("verified publish: %d %s", response.Code, response.Body.String())
	}
	promote := PromoteInput{RequestID: "verified-promote", OrganizationID: testOrg, ActorID: testActor, SkillRef: load.SkillRef, ExpectedDigest: load.ExpectedDigest}
	// Append the exact source to the published formal identity.
	var published Version
	if err := decodeOne(response.Body.Bytes(), &published); err != nil {
		t.Fatal(err)
	}
	promote.SkillID = published.SkillID
	promote.ExpectedVersion = 1
	req = httptest.NewRequest(http.MethodPost, "/internal/skill-projections/promote", bytes.NewReader(mustJSON(t, promote)))
	req.Header.Set("Content-Type", "application/json")
	h.Authorize(req, "admin-console")
	response = httptest.NewRecorder()
	h.ServeHTTP(response, req)
	if response.Code != 201 {
		t.Fatalf("verified promote: %d %s", response.Code, response.Body.String())
	}
	var creators int
	if err := pool.QueryRow(t.Context(), "SELECT count(*) FROM skill_versions WHERE skill_id=$1 AND created_by=$2", published.SkillID, testActor).Scan(&creators); err != nil || creators != 2 {
		t.Fatalf("untrusted persisted actor: count=%d err=%v", creators, err)
	}
	promote.ActorID = "user_00000000000000000000000000000002"
	req = httptest.NewRequest(http.MethodPost, "/internal/skill-projections/promote", bytes.NewReader(mustJSON(t, promote)))
	req.Header.Set("Content-Type", "application/json")
	h.Authorize(req, "admin-console")
	response = httptest.NewRecorder()
	h.ServeHTTP(response, req)
	if response.Code != 403 {
		t.Fatal("forged actor replay reached receipt")
	}
	var count int
	if err := pool.QueryRow(t.Context(), "SELECT count(*) FROM command_receipts").Scan(&count); err != nil || count != 2 {
		t.Fatal("rejected operation changed durable receipts")
	}
}
