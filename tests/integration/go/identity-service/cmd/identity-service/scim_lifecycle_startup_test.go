package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestSCIMLifecycleStartupWaitsForReconciliationBeforeListening(t *testing.T) {
	for _, revoke := range []bool{true, false} {
		for _, fail := range []bool{false, true} {
			t.Run(fmt.Sprintf("revoke=%v/failure=%v", revoke, fail), func(t *testing.T) {
				f := newBrowserStartupFixture(t)
				ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
				defer cancel()
				if _, err := f.pool.Exec(ctx, `INSERT INTO scim_tokens
					(id,organization_id,token_hash,name,scopes,created_at,expires_at,issued_by)
					VALUES ('startup-scim-token',$1,'startup-scim-hash','Startup token','{scim:write}',now(),now()+interval '1 day',$2)`, f.bootstrap.Organization.ID, f.bootstrap.User.ID); err != nil {
					t.Fatal(err)
				}
				if _, err := f.pool.Exec(ctx, `UPDATE users SET active=FALSE WHERE id=$1`, f.bootstrap.User.ID); err != nil {
					t.Fatal(err)
				}
				snapshot := func() string {
					t.Helper()
					var value string
					if err := f.pool.QueryRow(ctx, `SELECT jsonb_build_object(
						'tokens',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM scim_tokens t),
						'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM identity_events e))::text`).Scan(&value); err != nil {
						t.Fatal(err)
					}
					return value
				}
				before := snapshot()
				address := browserStartupAddress(t)
				baseLookup, _ := browserStartupEnvironment(t, f, address)
				lookup := func(key string) (string, bool) {
					if key == "ANTNEST_IDENTITY_SCIM_REVOKE_ON_ISSUER_LOSS" {
						return fmt.Sprint(revoke), true
					}
					return baseLookup(key)
				}
				blocker, err := f.pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer func() { _ = blocker.Rollback(context.WithoutCancel(ctx)) }()
				blockerPID, lockKey := blocker.Conn().PgConn().PID(), time.Now().UnixNano()
				if _, err := blocker.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, lockKey); err != nil {
					t.Fatal(err)
				}
				end := "RETURN NEW;"
				if fail {
					end = "RAISE EXCEPTION 'SCIM startup reconciliation marker' USING ERRCODE='P0001';"
				}
				if _, err := f.pool.Exec(ctx, fmt.Sprintf(`CREATE FUNCTION block_scim_startup() RETURNS trigger LANGUAGE plpgsql AS $$
					BEGIN PERFORM pg_advisory_xact_lock(%d); %s END $$;
					CREATE TRIGGER block_scim_startup BEFORE UPDATE ON scim_tokens FOR EACH ROW EXECUTE FUNCTION block_scim_startup()`, lockKey, end)); err != nil {
					t.Fatal(err)
				}
				done := make(chan struct{})
				var runErr error
				go func() { defer close(done); runErr = run(ctx, lookup) }()
				t.Cleanup(func() {
					cleanupCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
					defer stop()
					_ = blocker.Rollback(cleanupCtx)
					cancel()
					<-done
				})
				ticker := time.NewTicker(20 * time.Millisecond)
				defer ticker.Stop()
				for {
					var blocked bool
					if err := f.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
						WHERE application_name=$1 AND $2::int=ANY(pg_blocking_pids(pid)))`, f.applicationName, blockerPID).Scan(&blocked); err != nil {
						t.Fatal(err)
					}
					if blocked {
						break
					}
					conn, err := net.DialTimeout("tcp", address, 20*time.Millisecond)
					if err == nil {
						_ = conn.Close()
						t.Fatal("Identity opened its listener before SCIM issuer reconciliation")
					}
					select {
					case <-done:
						t.Fatalf("Identity stopped before the SCIM reconciliation barrier: %v", runErr)
					case <-ctx.Done():
						t.Fatal(ctx.Err())
					case <-ticker.C:
					}
				}
				probe, err := net.Listen("tcp", address)
				if err != nil {
					t.Fatalf("listener opened while SCIM startup was blocked: %v", err)
				}
				if err := probe.Close(); err != nil {
					t.Fatal(err)
				}
				if err := blocker.Rollback(ctx); err != nil {
					t.Fatal(err)
				}
				if fail {
					select {
					case <-done:
						var pgError *pgconn.PgError
						if serviceFailureClass(runErr) != "scim_lifecycle_initialization" || !errors.As(runErr, &pgError) || pgError.Code != "P0001" || pgError.Message != "SCIM startup reconciliation marker" {
							t.Fatalf("startup ignored failed SCIM reconciliation: %v", runErr)
						}
					case <-ctx.Done():
						t.Fatal(ctx.Err())
					}
					if snapshot() != before {
						t.Fatal("failed startup committed partial SCIM token or audit changes")
					}
					return
				}
				transport := http.DefaultTransport.(*http.Transport).Clone()
				transport.Proxy = nil
				defer transport.CloseIdleConnections()
				client := &http.Client{Transport: transport, Timeout: 100 * time.Millisecond}
				for {
					response, err := client.Get("http://" + address + "/status")
					if err == nil {
						_ = response.Body.Close()
						if response.StatusCode == http.StatusOK {
							break
						}
					}
					select {
					case <-done:
						t.Fatalf("Identity stopped after successful reconciliation: %v", runErr)
					case <-ctx.Done():
						t.Fatal(ctx.Err())
					case <-ticker.C:
					}
				}
				var revokedAt *time.Time
				var review bool
				if err := f.pool.QueryRow(ctx, `SELECT revoked_at,issuer_review_required FROM scim_tokens WHERE id='startup-scim-token'`).Scan(&revokedAt, &review); err != nil {
					t.Fatal(err)
				}
				if (revokedAt != nil) != revoke || review != !revoke {
					t.Fatalf("ready listener exposed unreconciled token: revoked=%v review=%v", revokedAt, review)
				}
				cancel()
				<-done
				if runErr != nil {
					t.Fatal(runErr)
				}
			})
		}
	}
}
