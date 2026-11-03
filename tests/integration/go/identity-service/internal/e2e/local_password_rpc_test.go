package e2e

import (
	"net/http"
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
	response := f.call(t, "local_login", body, "edge-gateway", "", http.StatusTooManyRequests, nil)
	assertCredentialFailure(t, response, http.StatusTooManyRequests,
		"credential_rate_limited", "Too many password attempts", "1")
	var rows, minimum, maximum int
	if err := f.pool.QueryRow(t.Context(), `SELECT count(*),min(failures),max(failures) FROM credential_attempts`).Scan(&rows, &minimum, &maximum); err != nil {
		t.Fatal(err)
	}
	if rows != 2 || minimum != 5 || maximum != 5 {
		t.Fatalf("rejected RPC changed the committed attempt state: rows=%d min=%d max=%d", rows, minimum, maximum)
	}
	f.assertIssued(t, 0)
}
