package telemetry

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestObservedCatalogStoreEmitsBoundedOperationSpan(t *testing.T) {
	previousProvider := otel.GetTracerProvider()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		_ = provider.Shutdown(context.Background())
		otel.SetTracerProvider(previousProvider)
	})

	next := &catalogStoreStub{err: errors.New("credential=top-secret")}
	observed, err := ObserveCatalogStore(next, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("observe Catalog store: %v", err)
	}
	if _, err := observed.PutModelProfile(context.Background(), ports.ModelProfileRecord{}); err == nil {
		t.Fatal("repository error was swallowed")
	}
	ended := recorder.Ended()
	if len(ended) != 1 || ended[0].Name() != "agent_controller.repository.create_model_profile" {
		t.Fatalf("repository spans = %#v", ended)
	}
	if ended[0].Status().Code != codes.Error || ended[0].Status().Description != "persistence_error" {
		t.Fatalf("repository span status = %+v", ended[0].Status())
	}
	if len(ended[0].Events()) != 0 {
		t.Fatalf("repository span recorded raw error events: %+v", ended[0].Events())
	}
}

type catalogStoreStub struct{ err error }

func (store *catalogStoreStub) ReplayModelProfileRequest(
	context.Context, ports.CatalogRequestKind, string, string,
) (ports.ModelProfileRecord, bool, error) {
	return ports.ModelProfileRecord{}, false, store.err
}

func (store *catalogStoreStub) PutModelProfile(
	context.Context, ports.ModelProfileRecord,
) (ports.ModelProfileRecord, error) {
	return ports.ModelProfileRecord{}, store.err
}

func (store *catalogStoreStub) ReviseModelProfile(
	context.Context, int64, ports.ModelProfileRecord,
) (ports.ModelProfileRecord, error) {
	return ports.ModelProfileRecord{}, store.err
}

func (store *catalogStoreStub) GetModelProfile(
	context.Context, string,
) (ports.ModelProfileRecord, error) {
	return ports.ModelProfileRecord{}, store.err
}

func (store *catalogStoreStub) GetModelProfileRevision(
	context.Context, string,
) (domain.ModelProfileRevision, error) {
	return domain.ModelProfileRevision{}, store.err
}

func (store *catalogStoreStub) ListModelProfiles(
	context.Context, string, string, int,
) ([]ports.ModelProfileRecord, string, error) {
	return nil, "", store.err
}

func (store *catalogStoreStub) ReplayTemplateRequest(
	context.Context, ports.CatalogRequestKind, string, string,
) (ports.TemplateRecord, bool, error) {
	return ports.TemplateRecord{}, false, store.err
}

func (store *catalogStoreStub) PutTemplate(
	context.Context, ports.TemplateRecord,
) (ports.TemplateRecord, error) {
	return ports.TemplateRecord{}, store.err
}

func (store *catalogStoreStub) ReviseTemplate(
	context.Context, int64, ports.TemplateRecord,
) (ports.TemplateRecord, error) {
	return ports.TemplateRecord{}, store.err
}

func (store *catalogStoreStub) GetTemplate(
	context.Context, string,
) (ports.TemplateRecord, error) {
	return ports.TemplateRecord{}, store.err
}

func (store *catalogStoreStub) ListTemplates(
	context.Context, string, string, int,
) ([]ports.TemplateRecord, string, error) {
	return nil, "", store.err
}
