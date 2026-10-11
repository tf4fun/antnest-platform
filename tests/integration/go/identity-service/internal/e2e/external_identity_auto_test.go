package e2e

import (
	"os"
	"testing"
)

func TestExternalIdentityAutomaticBindingAuditIsAtomic(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_IDENTITY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_IDENTITY_TEST_DATABASE_URL is not set")
	}
	for _, failAudit := range []bool{false, true} {
		name := "one_event_for_first_binding"
		if failAudit {
			name = "failed_binding_audit_rolls_back_login"
		}
		t.Run(name, func(t *testing.T) {
			f := newOIDCAdmissionFixture(t, databaseURL)
			if failAudit {
				if _, err := f.pool.Exec(t.Context(), `
					CREATE FUNCTION reject_binding_audit() RETURNS trigger LANGUAGE plpgsql AS $$
					BEGIN IF NEW.event_type = 'external_identity.bound' THEN
					RAISE EXCEPTION 'injected binding audit failure'; END IF; RETURN NEW; END $$;
					CREATE TRIGGER reject_binding_audit BEFORE INSERT ON identity_events
					FOR EACH ROW EXECUTE FUNCTION reject_binding_audit()`); err != nil {
					t.Fatal(err)
				}
			}
			result, err := f.flow.CompleteLogin(t.Context(), f.start(t))
			var bindings, tokens, boundEvents, completed int
			if queryErr := f.pool.QueryRow(t.Context(), `SELECT
				(SELECT count(*) FROM external_identities), (SELECT count(*) FROM api_tokens),
				(SELECT count(*) FROM identity_events WHERE event_type = 'external_identity.bound'),
				(SELECT count(*) FROM identity_events WHERE event_type = 'oidc_login.completed')`).
				Scan(&bindings, &tokens, &boundEvents, &completed); queryErr != nil {
				t.Fatal(queryErr)
			}
			if failAudit {
				if err == nil || result.AccessToken != "" || bindings != 0 || tokens != 0 || boundEvents != 0 || completed != 0 {
					t.Fatalf("failed audit must roll back binding and login: bindings=%d tokens=%d bound=%d completed=%d err=%v", bindings, tokens, boundEvents, completed, err)
				}
				return
			}
			if err != nil || result.AccessToken == "" || bindings != 1 || tokens != 1 || boundEvents != 1 || completed != 1 {
				t.Fatalf("first binding audit missing: bindings=%d tokens=%d bound=%d completed=%d err=%v", bindings, tokens, boundEvents, completed, err)
			}
			if _, err := f.flow.CompleteLogin(t.Context(), f.start(t)); err != nil {
				t.Fatal(err)
			}
			if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM identity_events WHERE event_type = 'external_identity.bound'`).Scan(&boundEvents); err != nil || boundEvents != 1 {
				t.Fatalf("existing binding generated duplicate audit: count=%d err=%v", boundEvents, err)
			}
		})
	}
}
