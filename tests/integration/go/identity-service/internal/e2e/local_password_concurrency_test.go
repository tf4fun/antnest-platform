package e2e

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/localauth"
)

type localLoginResult struct {
	login localauth.LoginResult
	err   error
}

func awaitLocalLogin(t *testing.T, ctx context.Context, done <-chan localLoginResult) localLoginResult {
	t.Helper()
	select {
	case result := <-done:
		return result
	case <-ctx.Done():
		t.Fatal(ctx.Err())
		return localLoginResult{}
	}
}

func TestLocalPasswordLoginFifthCommitBlocksSixthAcrossInstances(t *testing.T) {
	f, auth, _ := localPasswordFixture(t)
	for range 4 {
		if _, err := auth.Login(t.Context(), localPasswordInput("incorrect member password")); !errors.Is(err, domain.ErrUnauthenticated) {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	var fifthPID atomic.Uint32
	fifthStore := f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
		if strings.Contains(sql, "INSERT INTO credential_attempts") {
			fifthPID.Store(conn.PgConn().PID())
		}
	})
	entered, release := make(chan struct{}), make(chan struct{})
	fifthPasswords := &loginPasswordProbe{LoginPasswords: testPasswordEngine(t), beforeVerify: func(ctx context.Context) error {
		close(entered)
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}}
	fifthAuth, err := localauth.NewService(t.Context(), fifthStore.LocalAuth(), f.newID, f.clock, time.Hour, fifthPasswords)
	if err != nil {
		t.Fatal(err)
	}
	fifthDone := make(chan localLoginResult, 1)
	workers.Go(func() {
		login, err := fifthAuth.Login(ctx, localPasswordInput("incorrect member password"))
		fifthDone <- localLoginResult{login, err}
	})
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	sixthReady := make(chan uint32, 1)
	var observed sync.Once
	sixthStore := f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
		if strings.Contains(sql, "INSERT INTO credential_attempts") {
			observed.Do(func() { sixthReady <- conn.PgConn().PID() })
		}
	})
	sixthPasswords := &loginPasswordProbe{LoginPasswords: testPasswordEngine(t)}
	sixthAuth, err := localauth.NewService(t.Context(), sixthStore.LocalAuth(), f.newID, f.clock, time.Hour, sixthPasswords)
	if err != nil {
		t.Fatal(err)
	}
	sixthDone := make(chan localLoginResult, 1)
	workers.Go(func() {
		login, err := sixthAuth.Login(ctx, localPasswordInput("correct horse battery staple"))
		sixthDone <- localLoginResult{login, err}
	})
	select {
	case pid := <-sixthReady:
		assertBrowserBlocker(t, ctx, browserControlsFixture{localAdmissionFixture: f}, pid, fifthPID.Load())
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	close(release)
	if result := awaitLocalLogin(t, ctx, fifthDone); !errors.Is(result.err, domain.ErrUnauthenticated) || result.login.AccessToken != "" {
		t.Fatalf("fifth did not commit a normal rejection: %v", result.err)
	}
	if result := awaitLocalLogin(t, ctx, sixthDone); !errors.Is(result.err, domain.ErrCredentialRateLimited) || result.login.AccessToken != "" || sixthPasswords.verifications.Load() != 0 {
		t.Fatalf("sixth used stale counters or performed KDF: calls=%d error=%v", sixthPasswords.verifications.Load(), result.err)
	}
	var rows int
	if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM credential_attempts WHERE failures=5`).Scan(&rows); err != nil || rows != 2 {
		t.Fatalf("fifth/sixth lost or double-counted a failure: rows=%d error=%v", rows, err)
	}
	f.assertIssuanceCount(t, 0)
}

func TestLocalPasswordLoginAcrossOrganizationsLocksCredentialBeforeRehash(t *testing.T) {
	f, auth, _ := localPasswordFixture(t)
	existing, err := auth.Login(t.Context(), localPasswordInput("correct horse battery staple"))
	if err != nil {
		t.Fatal(err)
	}
	other := (browserControlsFixture{localAdmissionFixture: f}).otherOrganization(t)
	oldHash := installLegacyLocalPassword(t, f)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	var firstPID atomic.Uint32
	firstStore := f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
		if strings.Contains(sql, "FROM local_credentials") && strings.Contains(sql, "FOR UPDATE") {
			firstPID.Store(conn.PgConn().PID())
		}
	})
	entered, release := make(chan struct{}), make(chan struct{})
	firstPasswords := &loginPasswordProbe{LoginPasswords: testPasswordEngine(t), beforeVerify: func(ctx context.Context) error {
		close(entered)
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}}
	firstAuth, err := localauth.NewService(t.Context(), firstStore.LocalAuth(), f.newID, f.clock, time.Hour, firstPasswords)
	if err != nil {
		t.Fatal(err)
	}
	firstDone := make(chan localLoginResult, 1)
	workers.Go(func() {
		login, err := firstAuth.Login(ctx, localPasswordInput("correct horse battery staple"))
		firstDone <- localLoginResult{login, err}
	})
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	secondReady := make(chan uint32, 1)
	var observed sync.Once
	secondStore := f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
		if strings.Contains(sql, "FROM local_credentials") && strings.Contains(sql, "FOR UPDATE") {
			observed.Do(func() { secondReady <- conn.PgConn().PID() })
		}
	})
	secondPasswords := &loginPasswordProbe{LoginPasswords: testPasswordEngine(t)}
	secondAuth, err := localauth.NewService(t.Context(), secondStore.LocalAuth(), f.newID, f.clock, time.Hour, secondPasswords)
	if err != nil {
		t.Fatal(err)
	}
	secondDone := make(chan localLoginResult, 1)
	input := localPasswordInput("correct horse battery staple")
	input.OrganizationSlug = other.Slug
	workers.Go(func() {
		login, err := secondAuth.Login(ctx, input)
		secondDone <- localLoginResult{login, err}
	})
	select {
	case pid := <-secondReady:
		assertBrowserBlocker(t, ctx, browserControlsFixture{localAdmissionFixture: f}, pid, firstPID.Load())
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	close(release)
	for _, done := range []<-chan localLoginResult{firstDone, secondDone} {
		if result := awaitLocalLogin(t, ctx, done); result.err != nil || result.login.AccessToken == "" {
			t.Fatalf("shared-User login failed serialization: %v", result.err)
		}
	}
	if firstPasswords.hashes.Load() != 1 || secondPasswords.hashes.Load() != 0 || secondPasswords.verifications.Load() != 1 {
		t.Fatal("second Organization reused the legacy credential instead of reading the committed rehash")
	}
	var stored string
	if err := f.pool.QueryRow(t.Context(), `SELECT password_hash FROM local_credentials WHERE user_id=$1`, f.user.User.ID).Scan(&stored); err != nil || stored == oldHash {
		t.Fatalf("legacy credential was not replaced: %v", err)
	}
	if _, err := auth.Resolve(t.Context(), existing.AccessToken); err != nil {
		t.Fatalf("concurrent rehash revoked an existing session: %v", err)
	}
	f.assertIssuanceCount(t, 3)
}
