package e2e

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgproto3"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/localauth"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/repository"
)

type localLoginCommitFault struct {
	armed          atomic.Bool
	observedCommit atomic.Bool
	begins         atomic.Int32
	commits        atomic.Int32
}

func (f *localLoginCommitFault) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	switch data.SQL {
	case "begin":
		f.begins.Add(1)
	case "commit":
		f.commits.Add(1)
		f.armed.Store(true)
	}
	return ctx
}

func (*localLoginCommitFault) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

type lostLocalLoginCommitConn struct {
	net.Conn
	fault *localLoginCommitFault
}

func (c *lostLocalLoginCommitConn) Read(buffer []byte) (int, error) {
	if !c.fault.armed.CompareAndSwap(true, false) {
		return c.Conn.Read(buffer)
	}
	// Consume the actual PostgreSQL COMMIT response, then sever the connection
	// without delivering any response bytes to pgx. A second connection below
	// verifies durable effects; no repository result or commit is stubbed.
	frontend := pgproto3.NewFrontend(c.Conn, io.Discard)
	for {
		message, err := frontend.Receive()
		if err != nil {
			return 0, err
		}
		if complete, ok := message.(*pgproto3.CommandComplete); ok {
			c.fault.observedCommit.Store(bytes.Equal(complete.CommandTag, []byte("COMMIT")))
			_ = c.Close()
			return 0, io.ErrUnexpectedEOF
		}
		if _, failed := message.(*pgproto3.ErrorResponse); failed {
			_ = c.Close()
			return 0, io.ErrUnexpectedEOF
		}
	}
}

func TestLocalPasswordLoginLostCommitAcknowledgementDoesNotRetryOrExposeCredentials(t *testing.T) {
	for _, success := range []bool{false, true} {
		name := "failed-guess"
		if success {
			name = "successful-rehash"
		}
		t.Run(name, func(t *testing.T) {
			f, auth, _ := localPasswordFixture(t)
			existing, err := auth.Login(t.Context(), localPasswordInput("correct horse battery staple"))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := auth.Login(t.Context(), localPasswordInput("incorrect member password")); !errors.Is(err, domain.ErrUnauthenticated) {
				t.Fatal(err)
			}
			oldHash := installLegacyLocalPassword(t, f)
			fault := &localLoginCommitFault{}
			config := f.pool.Config()
			config.MaxConns, config.MinConns = 1, 0
			config.ConnConfig.Tracer = fault
			dial := config.ConnConfig.DialFunc
			config.ConnConfig.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
				connection, err := dial(ctx, network, address)
				if err != nil {
					return nil, err
				}
				return &lostLocalLoginCommitConn{Conn: connection, fault: fault}, nil
			}
			pool, err := pgxpool.NewWithConfig(t.Context(), config)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(pool.Close)
			store, err := repository.New(pool, f.newID, time.Now)
			if err != nil {
				t.Fatal(err)
			}
			passwords := &loginPasswordProbe{LoginPasswords: testPasswordEngine(t)}
			uncertain, err := localauth.NewService(t.Context(), store.LocalAuth(), f.newID, time.Now, time.Hour, passwords)
			if err != nil {
				t.Fatal(err)
			}
			password := "incorrect member password"
			if success {
				password = "correct horse battery staple"
			}
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			result, err := uncertain.Login(ctx, localPasswordInput(password))
			code, _, _ := domain.ErrorDetails(err)
			if err == nil || code != "internal_error" || result != (localauth.LoginResult{}) {
				t.Fatalf("lost commit acknowledgement exposed credentials or became a confirmed rejection: %v", err)
			}
			if !fault.observedCommit.Load() || fault.begins.Load() != 1 || fault.commits.Load() != 1 || passwords.verifications.Load() != 1 {
				t.Fatalf("commit response was not lost exactly once, or request was retried: observed=%t begins=%d commits=%d verifications=%d",
					fault.observedCommit.Load(), fault.begins.Load(), fault.commits.Load(), passwords.verifications.Load())
			}
			var account, organization int
			var stored string
			if err := f.pool.QueryRow(t.Context(), `SELECT
				(SELECT failures FROM credential_attempts WHERE scope='login_account'),
				(SELECT failures FROM credential_attempts WHERE scope='organization'),
				(SELECT password_hash FROM local_credentials WHERE user_id=$1)`, f.user.User.ID).Scan(&account, &organization, &stored); err != nil {
				t.Fatal(err)
			}
			if success {
				needs, err := passwords.NeedsRehash(stored)
				if err != nil || needs || stored == oldHash || account != 0 || organization != 1 || passwords.hashes.Load() != 1 {
					t.Fatalf("successful commit was compensated or retried: account=%d organization=%d rehash=%t hashCalls=%d error=%v", account, organization, needs, passwords.hashes.Load(), err)
				}
				f.assertIssuanceCount(t, 2)
			} else {
				if stored != oldHash || account != 2 || organization != 2 || passwords.hashes.Load() != 0 {
					t.Fatalf("failed-guess commit was compensated or retried: account=%d organization=%d hashCalls=%d", account, organization, passwords.hashes.Load())
				}
				f.assertIssuanceCount(t, 1)
			}
			if _, err := auth.Resolve(t.Context(), existing.AccessToken); err != nil {
				t.Fatalf("lost acknowledgement revoked a pre-existing session: %v", err)
			}
		})
	}
}
