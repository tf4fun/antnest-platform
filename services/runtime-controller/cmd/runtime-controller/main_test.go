package main

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"testing"
)

func TestFailureClassificationExposesOnlyStableDiagnostics(t *testing.T) {
	secret := errors.New("postgres://user:secret@database/runtime")
	component, class := failureClassification(classified("repository", "database_connection_failed", secret))
	if component != "repository" || class != "database_connection_failed" {
		t.Fatalf("classification = %q/%q", component, class)
	}
	component, class = failureClassification(secret)
	if component != "runtime_controller" || class != "unexpected_error" {
		t.Fatalf("unexpected failure leaked into classification = %q/%q", component, class)
	}
	diagnostic := safeDiagnostic(secret)
	if strings.Contains(diagnostic, "secret") || !strings.Contains(diagnostic, "REDACTED") {
		t.Fatalf("safe diagnostic leaked credentials: %q", diagnostic)
	}
}

func TestRuntimeStatusClientDoesNotUseEnvironmentProxy(t *testing.T) {
	transport, ok := runtimeStatusHTTPClient().Transport.(*http.Transport)
	if !ok || transport.Proxy != nil {
		t.Fatalf("Runtime status transport may proxy internal traffic: %#v", transport)
	}
}

func TestRuntimeFailureIsLoggedBeforeTelemetryShutdown(t *testing.T) {
	var output bytes.Buffer
	lifecycle := &recordingTelemetryLifecycle{
		logger: slog.New(slog.NewJSONHandler(&output, nil)),
		output: &output,
	}
	finishTelemetry(lifecycle, classified("platform", "platform_watch_failed", errors.New("watch stopped")))
	if !lifecycle.shutdownCalled {
		t.Fatal("telemetry was not shut down")
	}
	if !lifecycle.failureVisibleAtShutdown {
		t.Fatalf("terminal failure was not logged before shutdown: %s", output.String())
	}
	if !strings.Contains(output.String(), `"component":"platform"`) ||
		!strings.Contains(output.String(), `"error_class":"platform_watch_failed"`) {
		t.Fatalf("terminal failure lacked stable classification: %s", output.String())
	}
}

type recordingTelemetryLifecycle struct {
	logger                   *slog.Logger
	output                   *bytes.Buffer
	shutdownCalled           bool
	failureVisibleAtShutdown bool
}

func (l *recordingTelemetryLifecycle) Logger() *slog.Logger { return l.logger }

func (l *recordingTelemetryLifecycle) Shutdown(context.Context) error {
	l.shutdownCalled = true
	l.failureVisibleAtShutdown = strings.Contains(l.output.String(), "Runtime Controller stopped")
	return nil
}
