package runtimeclient

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/instanceauth"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/serviceauth"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/telemetry"
)

const maxStatusBytes = 16 << 10

var ErrNotReady = errors.New("runtime is not ready")

var (
	statusTracer   = otel.Tracer("github.com/tf4fun/antnest-platform/runtime-controller/runtimeclient")
	statusMeter    = otel.Meter("github.com/tf4fun/antnest-platform/runtime-controller/runtimeclient")
	statusChecks   = mustCounter(statusMeter.Int64Counter("runtime.status.verifications"))
	statusDuration = mustHistogram(statusMeter.Float64Histogram(
		"runtime.status.verification.duration", metric.WithUnit("s"),
	))
)

type Client struct {
	httpClient       *http.Client
	timeout          time.Duration
	credentialSource CredentialSource
}

type CredentialSource func(context.Context, deployment.Inspection) (string, error)

// NewAuthenticated binds status authority to the trusted generation inspected by
// Docker. The source returns a private instance file, never a global token.
func NewAuthenticated(httpClient *http.Client, timeout time.Duration, source CredentialSource) (*Client, error) {
	if httpClient == nil || source == nil {
		return nil, fmt.Errorf("instance credential source and HTTP client are required")
	}
	private := *httpClient
	if private.Transport == nil {
		private.Transport = http.DefaultTransport.(*http.Transport).Clone()
	}
	if transport, ok := private.Transport.(*http.Transport); ok {
		pinned := transport.Clone()
		pinned.Proxy = nil
		private.Transport = pinned
	}
	private.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	client, err := newClient(&private, timeout)
	if err != nil {
		return nil, err
	}
	client.credentialSource = source
	return client, nil
}

func newClient(httpClient *http.Client, timeout time.Duration) (*Client, error) {
	if httpClient == nil || timeout <= 0 {
		return nil, fmt.Errorf("HTTP client and positive status timeout are required")
	}
	observed := *httpClient
	observed.Transport = telemetry.NewTransport(httpClient.Transport, "antnest-runtime")
	return &Client{httpClient: &observed, timeout: timeout}, nil
}

func (c *Client) Verify(
	ctx context.Context, inspection deployment.Inspection,
) (verified deployment.Inspection, resultErr error) {
	started := time.Now()
	ctx, span := statusTracer.Start(ctx, "runtime.status.verify", trace.WithSpanKind(trace.SpanKindInternal))
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
			telemetry.RecordFailure(ctx, span, resultErr, "runtime_status", result, "Runtime status verification failed")
		}
		if verified.RuntimeExecutionID != "" {
			span.SetAttributes(attribute.String("antnest.runtime.execution_id", telemetry.SafeValue(verified.RuntimeExecutionID)))
		}
		attributes := []attribute.KeyValue{attribute.String("antnest.result", result)}
		span.SetAttributes(attributes...)
		span.End()
		statusChecks.Add(ctx, 1, metric.WithAttributes(attributes...))
		statusDuration.Record(ctx, time.Since(started).Seconds(), metric.WithAttributes(attributes...))
	}()
	if strings.TrimSpace(inspection.StatusEndpoint) == "" {
		return deployment.Inspection{}, fmt.Errorf("runtime status endpoint is missing")
	}
	requestCtx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, inspection.StatusEndpoint, nil)
	if err != nil {
		return deployment.Inspection{}, fmt.Errorf("create Runtime status request: %w", err)
	}
	if c.credentialSource != nil {
		target, parseErr := url.Parse(inspection.StatusEndpoint)
		if parseErr != nil || target.Host == "" || target.Scheme != "http" || target.User != nil || target.Opaque != "" || target.Path != "/status" || target.RawPath != "" || target.RawQuery != "" || target.ForceQuery || target.Fragment != "" {
			return deployment.Inspection{}, fmt.Errorf("trusted Runtime status target is invalid")
		}
		path, authErr := c.credentialSource(requestCtx, inspection)
		if authErr != nil {
			return deployment.Inspection{}, fmt.Errorf("accepted instance status authority is unavailable")
		}
		token, readErr := instanceauth.ReadSenderFile(path)
		if readErr != nil || !serviceauth.ValidToken(token) {
			return deployment.Inspection{}, fmt.Errorf("accepted instance status authority is unavailable")
		}
		request.Header.Set(serviceauth.Header, "Bearer "+string(token))
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return deployment.Inspection{}, fmt.Errorf("request Runtime status: %w", err)
	}
	defer joinCloseError(&resultErr, response.Body.Close)
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxStatusBytes))
		return deployment.Inspection{}, fmt.Errorf("runtime status returned %s", response.Status)
	}
	var status struct {
		AgentID      string   `json:"agent_id"`
		Generation   uint64   `json:"generation"`
		ExecutionID  string   `json:"execution_id"`
		Status       string   `json:"status"`
		TestFeatures []string `json:"test_features"`
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxStatusBytes+1))
	if err != nil || len(raw) > maxStatusBytes || serviceauth.DecodeObject(raw, &status) != nil {
		return deployment.Inspection{}, fmt.Errorf("runtime status must contain one bounded strict UTF-8 JSON object")
	}
	if status.AgentID != inspection.AgentID || status.Generation != inspection.Generation {
		return deployment.Inspection{}, deployment.ErrIdentityConflict
	}
	if status.Status != "ready" {
		return deployment.Inspection{}, fmt.Errorf("%w: status is %q", ErrNotReady, status.Status)
	}
	if strings.TrimSpace(status.ExecutionID) == "" {
		return deployment.Inspection{}, fmt.Errorf("runtime ready status is missing execution identity")
	}
	inspection.RuntimeExecutionID = status.ExecutionID
	inspection.ObservedAt = time.Now().UTC()
	return inspection, nil
}

func joinCloseError(resultErr *error, closeFunc func() error) {
	if err := closeFunc(); err != nil {
		*resultErr = errors.Join(*resultErr, fmt.Errorf("close runtime status response: %w", err))
	}
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
