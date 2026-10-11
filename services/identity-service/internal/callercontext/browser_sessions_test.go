package callercontext

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	protocol "github.com/tf4fun/antnest-platform/modules/service-authentication/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

func TestBrowserSessionProfileGrantsIdentityAlone(t *testing.T) {
	authority, store, now := newTestAuthority(t)
	session, token, err := authority.Issue(context.Background(), "ant_api_test", "session", "")
	if err != nil || session.Principal != store.session.Principal {
		t.Fatalf("session profile issuance failed: %v", err)
	}
	claims, err := protocol.Verify(token, authority.keys, protocol.Expected{Consumer: "identity-service", Now: now})
	if err != nil || !slices.Equal(claims.Audience, []string{"identity-service"}) || claims.Agent != nil {
		t.Fatalf("session profile did not grant Identity alone: %v", err)
	}
	for _, consumer := range []string{"admin-console", "agent-ui", "agent-controller", "agent-acp-service", "skill-registry"} {
		if _, err := protocol.Verify(token, authority.keys, protocol.Expected{Consumer: consumer, Now: now}); err == nil {
			t.Fatalf("session profile accepted by %s", consumer)
		}
	}
	if _, _, err := authority.Issue(context.Background(), "ant_api_test", "session", "agent-1"); err == nil {
		t.Fatal("session profile accepted Agent scope")
	}
}

type advancingSessionRepository struct {
	SessionRepository
	afterRawRead func()
	afterSIDRead func()
}

func (r advancingSessionRepository) ResolveTokenSession(ctx context.Context, hash string, now time.Time) (Session, error) {
	session, err := r.SessionRepository.ResolveTokenSession(ctx, hash, now)
	if r.afterRawRead != nil {
		r.afterRawRead()
	}
	return session, err
}

func (r advancingSessionRepository) ResolveSession(ctx context.Context, sid string, now time.Time) (Session, error) {
	session, err := r.SessionRepository.ResolveSession(ctx, sid, now)
	if r.afterSIDRead != nil {
		r.afterSIDRead()
	}
	return session, err
}

func TestIssueRejectsSessionExpiredWhileResolveWasPending(t *testing.T) {
	authority, store, now := newTestAuthority(t)
	store.session.ExpiresAt = now.Add(time.Second)
	current := now
	authority.now = func() time.Time { return current }
	authority.repository = advancingSessionRepository{SessionRepository: store, afterRawRead: func() {
		current = now.Add(2 * time.Second)
	}}
	_, token, err := authority.Issue(context.Background(), "ant_api_test", "console", "")
	if !errors.Is(err, domain.ErrUnauthenticated) || token != "" {
		t.Fatalf("expired post-wait authority issued a CCT: err=%v issued=%v", err, token != "")
	}
}

func TestVerifyRejectsSessionExpiredWhileLiveCheckWasPending(t *testing.T) {
	authority, store, now := newTestAuthority(t)
	store.session.ExpiresAt = now.Add(20 * time.Second)
	_, token, err := authority.Issue(context.Background(), "ant_api_test", "console", "")
	if err != nil {
		t.Fatal(err)
	}
	current := now
	authority.now = func() time.Time { return current }
	authority.repository = advancingSessionRepository{SessionRepository: store, afterSIDRead: func() {
		current = now.Add(21 * time.Second)
	}}
	if _, err := authority.VerifySession(context.Background(), token); !errors.Is(err, ErrInvalid) {
		t.Fatalf("live check used the time before waiting: %v", err)
	}
}

func TestVerifyRejectsCCTExpiredWhileLiveCheckWasPending(t *testing.T) {
	authority, store, now := newTestAuthority(t)
	_, token, err := authority.Issue(context.Background(), "ant_api_test", "console", "")
	if err != nil {
		t.Fatal(err)
	}
	current := now
	authority.now = func() time.Time { return current }
	authority.repository = advancingSessionRepository{SessionRepository: store, afterSIDRead: func() {
		current = now.Add(91 * time.Second)
	}}
	if _, err := authority.VerifySession(context.Background(), token); !errors.Is(err, ErrInvalid) {
		t.Fatalf("post-wait CCT expiry was ignored: %v", err)
	}
}

func TestIssueClipsCCTToIdleDeadline(t *testing.T) {
	authority, store, now := newTestAuthority(t)
	store.session.IdleExpiresAt = now.Add(20 * time.Second)
	_, token, err := authority.Issue(t.Context(), "ant_api_test", "console", "")
	if err != nil {
		t.Fatal(err)
	}
	claims, err := protocol.Verify(token, authority.keys, protocol.Expected{Consumer: "identity-service", Now: now})
	if err != nil || claims.ExpiresAt != store.session.IdleExpiresAt.Unix() {
		t.Fatalf("issued CCT exceeded idle authority: expiry=%d err=%v", claims.ExpiresAt, err)
	}
}

func TestIssueRejectsIdleDeadlineReachedDuringStorageRead(t *testing.T) {
	authority, store, now := newTestAuthority(t)
	store.session.IdleExpiresAt = now.Add(20 * time.Second)
	current := now
	authority.now = func() time.Time { return current }
	authority.repository = advancingSessionRepository{SessionRepository: store, afterRawRead: func() {
		current = store.session.IdleExpiresAt
	}}
	_, token, err := authority.Issue(t.Context(), "ant_api_test", "console", "")
	if !errors.Is(err, domain.ErrUnauthenticated) || token != "" {
		t.Fatalf("idle-expired post-read session issued a CCT: error=%v issued=%v", err, token != "")
	}
}

func TestVerifyRejectsIdleDeadlineReachedDuringStorageRead(t *testing.T) {
	authority, store, now := newTestAuthority(t)
	store.session.IdleExpiresAt = now.Add(20 * time.Second)
	_, token, err := authority.Issue(t.Context(), "ant_api_test", "console", "")
	if err != nil {
		t.Fatal(err)
	}
	current := now
	authority.now = func() time.Time { return current }
	authority.repository = advancingSessionRepository{SessionRepository: store, afterSIDRead: func() {
		current = store.session.IdleExpiresAt
	}}
	if _, err := authority.VerifySession(t.Context(), token); !errors.Is(err, ErrInvalid) {
		t.Fatalf("idle deadline equality accepted after the live read: %v", err)
	}
}
