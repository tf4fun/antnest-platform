package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestRequestDrainRejectsNewRequestsAfterStop(t *testing.T) {
	called := false
	drain := newRequestDrain(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
	drain.stop()
	drain.stop()
	response := httptest.NewRecorder()
	drain.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/", nil))
	if response.Code != http.StatusServiceUnavailable || called {
		t.Fatalf("stopping service admitted request: status=%d called=%v", response.Code, called)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := drain.wait(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestRequestDrainWaitIsBoundedAndRetainsActiveHandler(t *testing.T) {
	started, release, finished := make(chan struct{}), make(chan struct{}), make(chan struct{})
	drain := newRequestDrain(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		close(started)
		<-release
	}))
	go func() {
		defer close(finished)
		drain.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))
	}()
	awaitSignal(t, started, "handler entry")
	drain.stop()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := drain.wait(ctx)
	close(release)
	awaitSignal(t, finished, "handler completion")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("active-handler wait ignored deadline: %v", err)
	}
	settled, stop := context.WithTimeout(context.Background(), time.Second)
	defer stop()
	if err := drain.wait(settled); err != nil {
		t.Fatalf("completed handler did not settle drain: %v", err)
	}
}
