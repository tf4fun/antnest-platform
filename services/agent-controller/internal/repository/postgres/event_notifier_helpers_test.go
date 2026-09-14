package postgres

import (
	"context"
	"os"
	"testing"
	"time"
)

func controllerTestConnection(t *testing.T) (context.Context, *Repository, string) {
	t.Helper()
	databaseURL := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	repository, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(repository.Close)
	return ctx, repository, databaseURL
}

func awaitAgentNotification(t *testing.T, ctx context.Context, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	case <-time.After(3 * time.Second):
		t.Fatal("missing committed Agent notification")
	}
}

func assertNoAgentNotification(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
		t.Fatal("unexpected Agent notification")
	case <-time.After(75 * time.Millisecond):
	}
}
