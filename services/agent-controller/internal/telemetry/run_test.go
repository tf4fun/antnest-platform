package telemetry

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestObservedRunStoreClassifiesBusinessRejection(t *testing.T) {
	recorder, cleanup := installRunSpanRecorder(t)
	defer cleanup()

	next := &observedRunStoreStub{err: ports.ErrCredentialNotAllowed}
	observed, err := ObserveRunStore(next, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("observe Run store: %v", err)
	}
	_, _ = observed.GetAdmissionCredential(
		context.Background(), "admission-1", "credential-1", time.Unix(1, 0).UTC(),
	)
	ended := recorder.Ended()
	if len(ended) != 1 || ended[0].Status().Code != codes.Error ||
		ended[0].Status().Description != "credential_not_allowed" {
		t.Fatalf("Run repository span = %#v", ended)
	}
}

func TestObservedRunStoreNeverRecordsCredentialMaterial(t *testing.T) {
	recorder, cleanup := installRunSpanRecorder(t)
	defer cleanup()

	next := &observedRunStoreStub{credential: ports.AdmissionCredential{
		Identity: ports.CredentialIdentity{
			OrganizationID: "org-secret", CredentialRef: "credential-secret",
			CredentialVersion: "version-secret",
		},
		SecretType: "bearer",
		Sealed:     ports.SealedSecret{Ciphertext: []byte("top-secret"), Nonce: []byte("nonce")},
	}}
	observed, err := ObserveRunStore(next, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("observe Run store: %v", err)
	}
	_, err = observed.GetAdmissionCredential(
		context.Background(), "admission-secret", "credential-secret", time.Unix(1, 0).UTC(),
	)
	if err != nil {
		t.Fatalf("get credential: %v", err)
	}
	ended := recorder.Ended()
	if len(ended) != 1 {
		t.Fatalf("Run repository spans = %#v", ended)
	}
	serialized := fmt.Sprint(ended[0].Attributes(), ended[0].Events(), ended[0].Status())
	for _, forbidden := range []string{
		"top-secret", "credential-secret", "version-secret", "org-secret", "admission-secret",
	} {
		if strings.Contains(serialized, forbidden) {
			t.Fatalf("Run span leaked %q: %s", forbidden, serialized)
		}
	}
}

func TestObservedRunStoreRecordsUnknownEffectSource(t *testing.T) {
	recorder, cleanup := installRunSpanRecorder(t)
	defer cleanup()

	observed, err := ObserveRunStore(
		&observedRunStoreStub{}, slog.New(slog.NewTextHandler(io.Discard, nil)),
	)
	if err != nil {
		t.Fatalf("observe Run store: %v", err)
	}
	_, err = observed.FinishRun(context.Background(), ports.FinishRunCommand{
		RequestID: "request-1", AdmissionID: "admission-1",
		Report: domain.TerminalReport{
			Class: domain.TerminalUnresolved, ToolEffectState: domain.ToolEffectUnknown,
			UnknownEffectSource: domain.UnknownEffectClientMCP,
			ErrorClass:          "tool_effect_unknown",
		},
		Now: time.Unix(1, 0).UTC(),
	})
	if err != nil {
		t.Fatalf("finish Run: %v", err)
	}
	ended := recorder.Ended()
	if len(ended) != 1 {
		t.Fatalf("Run repository spans = %#v", ended)
	}
	attributes := map[string]any{}
	for _, item := range ended[0].Attributes() {
		attributes[string(item.Key)] = item.Value.AsInterface()
	}
	if attributes["antnest.run.unknown_effect_source"] != "client_mcp" {
		t.Fatalf("FinishRun attributes = %+v", attributes)
	}
}

func installRunSpanRecorder(t *testing.T) (*tracetest.SpanRecorder, func()) {
	t.Helper()
	previousProvider := otel.GetTracerProvider()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(provider)
	return recorder, func() {
		_ = provider.Shutdown(context.Background())
		otel.SetTracerProvider(previousProvider)
	}
}

type observedRunStoreStub struct {
	credential ports.AdmissionCredential
	err        error
}

func (store *observedRunStoreStub) ResolveAgentAccess(
	context.Context, string,
) (ports.AgentAccessResolution, error) {
	return ports.AgentAccessResolution{}, store.err
}

func (store *observedRunStoreStub) AcquireRun(
	context.Context, ports.AcquireRunRecord,
) (ports.RunAdmissionRecord, bool, error) {
	return ports.RunAdmissionRecord{}, false, store.err
}

func (store *observedRunStoreStub) FinishRun(
	context.Context, ports.FinishRunCommand,
) (ports.FinishRunRecord, error) {
	return ports.FinishRunRecord{}, store.err
}

func (store *observedRunStoreStub) GetAdmissionCredential(
	context.Context, string, string, time.Time,
) (ports.AdmissionCredential, error) {
	return store.credential, store.err
}

var _ ports.RunStore = (*observedRunStoreStub)(nil)
