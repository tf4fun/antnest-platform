package e2e

import (
	"net/http"
	"reflect"
	"testing"
)

func TestLocalPasswordRPCUsesPersistedAdmissionBeforeStoppedEngine(t *testing.T) {
	f := newPasswordResourceFixture(t)
	body := resourceLoginBody("password-resources", "admin@example.test")
	body["password"] = "incorrect password value"
	for range 5 {
		f.call(t, "local_login", body, "edge-gateway", "", http.StatusUnauthorized, nil)
	}
	// Persisted backoff must reject before entering the engine, even when a
	// verification would now produce credential_busy because it has stopped.
	f.engine.Stop()
	body["password"] = resourcePassword
	var failure map[string]any
	response := f.call(t, "local_login", body, "edge-gateway", "", http.StatusTooManyRequests, &failure)
	want := map[string]any{"code": "credential_rate_limited", "message": "Too many password attempts", "retryable": true}
	if !reflect.DeepEqual(failure, want) || !reflect.DeepEqual(response.Header().Values("Retry-After"), []string{"1"}) ||
		response.Header().Get("Cache-Control") != "no-store" || len(response.Header().Values("Set-Cookie")) != 0 {
		t.Fatal("persisted admission did not reach the canonical RPC 429 response")
	}
	var rows, minimum, maximum int
	if err := f.pool.QueryRow(t.Context(), `SELECT count(*),min(failures),max(failures) FROM credential_attempts`).Scan(&rows, &minimum, &maximum); err != nil {
		t.Fatal(err)
	}
	if rows != 2 || minimum != 5 || maximum != 5 {
		t.Fatalf("rejected RPC changed the committed attempt state: rows=%d min=%d max=%d", rows, minimum, maximum)
	}
	f.assertIssued(t, 0)
}
