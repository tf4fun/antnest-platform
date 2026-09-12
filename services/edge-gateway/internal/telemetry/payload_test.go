package telemetry

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/codes"
)

func TestHandlerErrorAutomaticallyRecordedWithoutRawMessage(t *testing.T) {
	recorder := recordHTTPSpans(t)
	var logs bytes.Buffer
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/session/login", Handler(func(w http.ResponseWriter, _ *http.Request) error {
		w.WriteHeader(http.StatusServiceUnavailable)
		return errors.Join(context.DeadlineExceeded, errors.New("private-canary"))
	}))
	HTTPHandler(mux, slog.New(slog.NewJSONHandler(&logs, nil))).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("POST", "/api/session/login", nil))
	spans := recorder.Ended()
	if len(spans) != 1 || spans[0].Status().Code != codes.Error || spans[0].Status().Description != "Request deadline exceeded" {
		t.Fatalf("spans=%+v", spans)
	}
	assertNoTraceValue(t, spans, "private-canary")
	if strings.Contains(logs.String(), "private-canary") || !strings.Contains(logs.String(), "deadline_exceeded") {
		t.Fatalf("logs=%s", logs.String())
	}
}
