package e2e

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/scim"
)

func useNanosecondSCIMUsageClock(f bindingFixture) {
	// Exercise PostgreSQL's microsecond persistence even on hosts whose clock
	// only supplies microseconds. A remainder above 500ns also detects rounding.
	f.advance(time.Microsecond + 731*time.Nanosecond - time.Duration(f.clock().Nanosecond()%1_000))
}

func (f scimVersionFixture) usageRequest(t *testing.T, kind, method, condition string) *httptest.ResponseRecorder {
	t.Helper()
	path := "/scim/v2/" + kind
	var body any
	if method != http.MethodPost {
		if kind == "Users" {
			path += "/" + f.user.Membership.ID
		} else {
			path += "/" + f.group.Group.ID
		}
	}
	switch method {
	case http.MethodPost, http.MethodPut:
		if kind == "Users" {
			externalID, userName := f.user.Membership.SCIMExternalID, f.user.Membership.SCIMUserName
			if method == http.MethodPost {
				externalID, userName = "second-usage-subject", "second-usage@example.com"
			}
			body = map[string]any{"schemas": []string{"urn:ietf:params:scim:schemas:core:2.0:User"},
				"externalId": externalID, "userName": userName, "displayName": "Usage user", "active": false}
		} else {
			body = map[string]any{"schemas": []string{"urn:ietf:params:scim:schemas:core:2.0:Group"}, "displayName": "Usage group"}
		}
	case http.MethodPatch:
		body = map[string]any{"schemas": []string{"urn:ietf:params:scim:api:messages:2.0:PatchOp"},
			"Operations": []map[string]any{{"op": "replace", "path": "displayName", "value": "Usage change"}}}
	}
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	handler, err := scim.NewHTTPHandler(f.service, "https://identity.example.com")
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(method, path, bytes.NewReader(raw))
	request.Header.Set("Authorization", "Bearer "+f.credential)
	if condition != "" {
		request.Header.Set("If-Match", condition)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestSCIMUsageAuthorizationIsReadOnly(t *testing.T) {
	f := newSCIMVersionFixture(t)
	if _, err := f.pool.Exec(t.Context(), `UPDATE scim_tokens SET last_used_at=NULL WHERE id=$1`, f.auth.TokenID); err != nil {
		t.Fatal(err)
	}
	before := f.versionSnapshot(t)
	if _, err := f.service.Authorize(t.Context(), f.credential, domain.SCIMScopeWrite); err != nil {
		t.Fatal(err)
	}
	if f.versionSnapshot(t) != before {
		t.Fatal("authentication alone persisted token usage")
	}
}

func TestSCIMUsageStaleHTTPWritesLeaveTokenRowUnchanged(t *testing.T) {
	for _, usage := range []string{"unused", "old"} {
		t.Run(usage, func(t *testing.T) {
			f := newSCIMVersionFixture(t)
			var lastUsedAt *time.Time
			if usage == "old" {
				old := f.clock().Add(-time.Hour)
				lastUsedAt = &old
			}
			if _, err := f.pool.Exec(t.Context(), `UPDATE scim_tokens SET last_used_at=$2 WHERE id=$1`, f.auth.TokenID, lastUsedAt); err != nil {
				t.Fatal(err)
			}
			for _, kind := range []string{"Users", "Groups"} {
				for _, method := range []string{http.MethodPut, http.MethodPatch, http.MethodDelete} {
					t.Run(kind+"/"+method, func(t *testing.T) {
						before := f.versionSnapshot(t)
						response := f.usageRequest(t, kind, method, `W/"0"`)
						if response.Code != http.StatusPreconditionFailed || f.versionSnapshot(t) != before {
							t.Fatalf("stale request status=%d body=%s or durable state changed", response.Code, response.Body.String())
						}
					})
				}
			}
		})
	}
}

func TestSCIMUsageSuccessfulHTTPWritesAndAuditRollback(t *testing.T) {
	for _, failAudit := range []bool{false, true} {
		mode := "success"
		if failAudit {
			mode = "audit-rollback"
		}
		for _, kind := range []string{"Users", "Groups"} {
			for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete} {
				t.Run(mode+"/"+kind+"/"+method, func(t *testing.T) {
					f := newSCIMVersionFixture(t)
					useNanosecondSCIMUsageClock(f.bindingFixture)
					if _, err := f.pool.Exec(t.Context(), `UPDATE scim_tokens SET last_used_at=NULL WHERE id=$1`, f.auth.TokenID); err != nil {
						t.Fatal(err)
					}
					f.advance(time.Second)
					if failAudit {
						if _, err := f.pool.Exec(t.Context(), `
							CREATE FUNCTION reject_scim_usage_audit() RETURNS trigger LANGUAGE plpgsql AS $$
							BEGIN RAISE EXCEPTION 'injected SCIM audit failure'; END $$;
							CREATE TRIGGER reject_scim_usage_audit BEFORE INSERT ON identity_events
							FOR EACH ROW EXECUTE FUNCTION reject_scim_usage_audit()`); err != nil {
							t.Fatal(err)
						}
					}
					before := f.versionSnapshot(t)
					response := f.usageRequest(t, kind, method, "*")
					if failAudit {
						if response.Code != http.StatusInternalServerError || f.versionSnapshot(t) != before {
							t.Fatalf("audit failure status=%d body=%s or durable state changed", response.Code, response.Body.String())
						}
						return
					}
					var lastUsedAt *time.Time
					if err := f.pool.QueryRow(t.Context(), `SELECT last_used_at FROM scim_tokens WHERE id=$1`, f.auth.TokenID).Scan(&lastUsedAt); err != nil {
						t.Fatal(err)
					}
					wantUsedAt := f.clock().Truncate(time.Microsecond)
					if response.Code >= 300 || lastUsedAt == nil || !lastUsedAt.Equal(wantUsedAt) {
						t.Fatalf("successful usage status=%d body=%s timestamp=%v want=%s", response.Code, response.Body.String(), lastUsedAt, wantUsedAt)
					}
				})
			}
		}
	}
}

func TestSCIMUsageSuccessfulReadRecordsAndThrottlesWithoutRowWrite(t *testing.T) {
	f := newSCIMVersionFixture(t)
	useNanosecondSCIMUsageClock(f.bindingFixture)
	if _, err := f.pool.Exec(t.Context(), `UPDATE scim_tokens SET last_used_at=NULL WHERE id=$1`, f.auth.TokenID); err != nil {
		t.Fatal(err)
	}
	response := f.usageRequest(t, "Users", http.MethodGet, "")
	var usedAt time.Time
	if err := f.pool.QueryRow(t.Context(), `SELECT last_used_at FROM scim_tokens WHERE id=$1`, f.auth.TokenID).Scan(&usedAt); err != nil {
		t.Fatal(err)
	}
	wantUsedAt := f.clock().Truncate(time.Microsecond)
	if response.Code != http.StatusOK || !usedAt.Equal(wantUsedAt) {
		t.Fatalf("read status=%d timestamp=%s want=%s", response.Code, usedAt, wantUsedAt)
	}
	before := f.versionSnapshot(t)
	f.advance(time.Minute)
	response = f.usageRequest(t, "Groups", http.MethodGet, "")
	if response.Code != http.StatusOK || f.versionSnapshot(t) != before {
		t.Fatalf("throttled read status=%d or changed token row", response.Code)
	}
	f.advance(5 * time.Minute)
	response = f.usageRequest(t, "Groups", http.MethodGet, "")
	if err := f.pool.QueryRow(t.Context(), `SELECT last_used_at FROM scim_tokens WHERE id=$1`, f.auth.TokenID).Scan(&usedAt); err != nil {
		t.Fatal(err)
	}
	wantUsedAt = f.clock().Truncate(time.Microsecond)
	if response.Code != http.StatusOK || !usedAt.Equal(wantUsedAt) {
		t.Fatalf("renewed usage status=%d timestamp=%s want=%s", response.Code, usedAt, wantUsedAt)
	}
}

func TestSCIMUsageFinalUserAuditRollsBackBindingNoticeAndUsage(t *testing.T) {
	for _, reprovision := range []bool{false, true} {
		mode := "create"
		if reprovision {
			mode = "reprovision"
		}
		t.Run(mode, func(t *testing.T) {
			f := newSCIMVersionFixture(t)
			input := scim.UserInput{ExternalID: "late-audit-subject", UserName: "late-audit@example.com", Email: "late-audit@example.com", DisplayName: "Late audit", Active: true}
			if reprovision {
				input = pairedUserInput()
				if err := f.service.DeleteUser(t.Context(), f.auth, f.user.Membership.ID, nil); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := f.pool.Exec(t.Context(), `UPDATE scim_tokens SET last_used_at=NULL WHERE id=$1`, f.auth.TokenID); err != nil {
				t.Fatal(err)
			}
			if _, err := f.pool.Exec(t.Context(), `
				CREATE FUNCTION reject_final_scim_user_audit() RETURNS trigger LANGUAGE plpgsql AS $$
				BEGIN IF NEW.event_type IN ('scim_user.created','scim_user.reprovisioned') THEN
					RAISE EXCEPTION 'injected final SCIM User audit failure';
				END IF; RETURN NEW; END $$;
				CREATE TRIGGER reject_final_scim_user_audit BEFORE INSERT ON identity_events
				FOR EACH ROW EXECUTE FUNCTION reject_final_scim_user_audit()`); err != nil {
				t.Fatal(err)
			}
			before := f.versionSnapshot(t)
			_, err := f.service.CreateUser(t.Context(), f.auth, input)
			var pgError *pgconn.PgError
			if !errors.As(err, &pgError) || pgError.Code != "P0001" || pgError.Message != "injected final SCIM User audit failure" {
				t.Fatalf("final audit injection was not reached: %v", err)
			}
			if f.versionSnapshot(t) != before {
				t.Fatal("final User audit failure left resource, binding, notice, token usage, audit or feed changes")
			}
		})
	}
}
