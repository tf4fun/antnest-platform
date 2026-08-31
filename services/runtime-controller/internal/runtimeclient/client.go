package runtimeclient

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"

	"soft/antnest-platform/services/runtime-controller/internal/deployment"
	"soft/antnest-platform/services/runtime-controller/internal/diagnostics"
)

const maxStatusBytes = 16 << 10

var ErrNotReady = errors.New("Runtime is not ready")

var (
	statusTracer   = otel.Tracer("soft/antnest-platform/runtime-controller/runtimeclient")
	statusMeter    = otel.Meter("soft/antnest-platform/runtime-controller/runtimeclient")
	statusChecks   = mustCounter(statusMeter.Int64Counter("runtime.status.verifications"))
	statusDuration = mustHistogram(statusMeter.Float64Histogram(
		"runtime.status.verification.duration", metric.WithUnit("s"),
	))
)

type Client struct {
	httpClient *http.Client
	timeout    time.Duration
}

func New(httpClient *http.Client, timeout time.Duration) (*Client, error) {
	if httpClient == nil || timeout <= 0 {
		return nil, fmt.Errorf("HTTP client and positive status timeout are required")
	}
	return &Client{httpClient: httpClient, timeout: timeout}, nil
}

func (c *Client) Verify(
	ctx context.Context, inspection deployment.Inspection,
) (verified deployment.Inspection, resultErr error) {
	started := time.Now()
	ctx, span := statusTracer.Start(ctx, "runtime.status.verify", trace.WithSpanKind(trace.SpanKindClient))
	span.SetAttributes(
		attribute.String("antnest.agent.id", inspection.AgentID),
		attribute.Int64("antnest.runtime.generation", int64(inspection.Generation)),
	)
	defer func() {
		result := "completed"
		if resultErr != nil {
			result = "error"
			if errors.Is(resultErr, deployment.ErrIdentityConflict) {
				result = "identity_conflict"
			}
			span.RecordError(diagnostics.Error(resultErr))
			span.SetStatus(codes.Error, result)
		}
		attributes := []attribute.KeyValue{attribute.String("antnest.result", result)}
		span.SetAttributes(attributes...)
		span.End()
		statusChecks.Add(ctx, 1, metric.WithAttributes(attributes...))
		statusDuration.Record(ctx, time.Since(started).Seconds(), metric.WithAttributes(attributes...))
	}()
	if strings.TrimSpace(inspection.StatusEndpoint) == "" {
		return deployment.Inspection{}, fmt.Errorf("Runtime status endpoint is missing")
	}
	requestCtx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, inspection.StatusEndpoint, nil)
	if err != nil {
		return deployment.Inspection{}, fmt.Errorf("create Runtime status request: %w", err)
	}
	otel.GetTextMapPropagator().Inject(requestCtx, propagation.HeaderCarrier(request.Header))
	response, err := c.httpClient.Do(request)
	if err != nil {
		return deployment.Inspection{}, fmt.Errorf("request Runtime status: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxStatusBytes))
		return deployment.Inspection{}, fmt.Errorf("Runtime status returned %s", response.Status)
	}
	var status struct {
		AgentID     string `json:"agent_id"`
		Generation  uint64 `json:"generation"`
		ExecutionID string `json:"execution_id"`
		Status      string `json:"status"`
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, maxStatusBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&status); err != nil {
		return deployment.Inspection{}, fmt.Errorf("decode Runtime status: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return deployment.Inspection{}, fmt.Errorf("Runtime status must contain one JSON object")
	}
	if status.AgentID != inspection.AgentID || status.Generation != inspection.Generation {
		return deployment.Inspection{}, deployment.ErrIdentityConflict
	}
	if status.Status != "ready" {
		return deployment.Inspection{}, fmt.Errorf("%w: status is %q", ErrNotReady, status.Status)
	}
	if strings.TrimSpace(status.ExecutionID) == "" {
		return deployment.Inspection{}, fmt.Errorf("Runtime ready status is missing execution identity")
	}
	inspection.RuntimeExecutionID = status.ExecutionID
	inspection.ObservedAt = time.Now().UTC()
	return inspection, nil
}

func mustCounter(instrument metric.Int64Counter, err error) metric.Int64Counter {
	if err != nil {
		panic(err)
	}
	return instrument
}

func mustHistogram(instrument metric.Float64Histogram, err error) metric.Float64Histogram {
	if err != nil {
		panic(err)
	}
	return instrument
}
