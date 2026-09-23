package main

import (
	"testing"
	"time"
)

func awaitGatewaySignal(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Gateway request lifecycle did not settle")
	}
}
