package identityclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"

	"soft/antnest-platform/services/agent-controller/internal/ports"
	"soft/antnest-platform/services/agent-controller/internal/telemetry"
)

const maximumResponseBytes = 1 << 20

var identityIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$`)

var (
	meter    = otel.Meter("soft/antnest-platform/agent-controller/identityclient")
	requests = mustCounter(meter.Int64Counter(
		"antnest.agent_controller.dependency.requests",
	))
	duration = mustHistogram(meter.Float64Histogram(
		"antnest.agent_controller.dependency.duration",
		metric.WithUnit("s"),
	))
)

type Client struct {
	baseURL    *url.URL
	httpClient *http.Client
	timeout    time.Duration
}

func New(baseURL string, timeout time.Duration, httpClient *http.Client) (*Client, error) {
	endpoint, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || endpoint.Host == "" ||
		(endpoint.Scheme != "http" && endpoint.Scheme != "https") || endpoint.User != nil ||
		endpoint.RawQuery != "" || endpoint.Fragment != "" ||
		(endpoint.Path != "" && endpoint.Path != "/") {
		return nil, fmt.Errorf("identity service URL must be an HTTP origin")
	}
	if timeout <= 0 {
		return nil, fmt.Errorf("identity service timeout must be positive")
	}
	if httpClient == nil {
		httpClient = &http.Client{}
	}
	effectiveClient := *httpClient
	effectiveClient.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &Client{baseURL: endpoint, httpClient: telemetry.HTTPClient(&effectiveClient, "identity-service"), timeout: timeout}, nil
}

func (client *Client) ResolvePrincipal(
	ctx context.Context, organizationID string, userID string,
) (result ports.IdentityPrincipal, resultErr error) {
	if !identityIDPattern.MatchString(organizationID) || !identityIDPattern.MatchString(userID) {
		return ports.IdentityPrincipal{}, dependencyFailure("invalid_request", false)
	}
	err := client.invoke(ctx, "resolve_principal", "/rpc/identity/resolve-principal",
		ownerRequest{UserID: userID, OrganizationID: organizationID}, func(body []byte) error {
			var wire struct {
				Principal principalWire `json:"principal"`
			}
			if err := decodeStrictJSON(body, &wire); err != nil || !wire.Principal.matches(organizationID, userID) {
				return dependencyFailure("invalid_response", true)
			}
			result = wire.Principal.principal()
			return nil
		})
	return result, err
}

func (client *Client) invoke(
	ctx context.Context, method, path string, input any, decode func([]byte) error,
) (resultErr error) {
	started := time.Now()
	ctx, cancel := context.WithTimeout(ctx, client.timeout)
	defer cancel()
	ctx, span := telemetry.StartHTTPCall(ctx, method, nil)
	defer func() {
		result, errorClass := dependencyObservation(resultErr)
		attributes := []attribute.KeyValue{
			attribute.String("rpc.service", "identity-service"),
			attribute.String("rpc.method", method),
			attribute.String("antnest.result", result),
			attribute.String("error.type", errorClass),
		}
		span.SetAttributes(attributes...)
		span.Finish(resultErr)
		requests.Add(ctx, 1, metric.WithAttributes(attributes...))
		duration.Record(ctx, time.Since(started).Seconds(), metric.WithAttributes(attributes...))
	}()

	payload, err := json.Marshal(input)
	if err != nil {
		return dependencyFailure("invalid_request", false)
	}
	endpoint := *client.baseURL
	endpoint.Path = path
	request, err := http.NewRequestWithContext(
		ctx, http.MethodPost, endpoint.String(), bytes.NewReader(payload),
	)
	if err != nil {
		return dependencyFailure("invalid_request", false)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.httpClient.Do(request)
	if err != nil {
		return dependencyFailure("identity_unavailable", true, err)
	}
	span.SetAttributes(attribute.Int("http.response.status_code", response.StatusCode))
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, maximumResponseBytes+1))
	closeErr := response.Body.Close()
	if err != nil || closeErr != nil || len(responseBody) > maximumResponseBytes {
		return dependencyFailure("invalid_response", true, err, closeErr)
	}
	mediaType, _, mediaTypeErr := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if mediaTypeErr != nil || mediaType != "application/json" {
		return dependencyFailure("invalid_response", true)
	}
	if response.StatusCode != http.StatusOK {
		return decodeFailure(responseBody, response.StatusCode)
	}
	return decode(responseBody)
}

func decodeFailure(payload []byte, status int) error {
	var response struct {
		Code      string `json:"code"`
		Message   string `json:"message"`
		Retryable *bool  `json:"retryable"`
	}
	if err := decodeStrictJSON(payload, &response); err != nil ||
		strings.TrimSpace(response.Message) == "" || response.Retryable == nil {
		return dependencyFailure("invalid_response", true)
	}
	expected, ok := resolvePrincipalFailures[response.Code]
	if !ok || expected.status != status || expected.retryable != *response.Retryable {
		return dependencyFailure("invalid_response", true)
	}
	return dependencyFailure(response.Code, *response.Retryable)
}

func decodeStrictJSON(payload []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return fmt.Errorf("JSON response contains trailing data")
	}
	return nil
}

type failureContract struct {
	status    int
	retryable bool
}

var resolvePrincipalFailures = map[string]failureContract{
	"bad_request":      {status: http.StatusBadRequest, retryable: false},
	"invalid_argument": {status: http.StatusBadRequest, retryable: false},
	"not_found":        {status: http.StatusNotFound, retryable: false},
	"internal_error":   {status: http.StatusInternalServerError, retryable: true},
}

func dependencyFailure(code string, retryable bool, causes ...error) error {
	return &ports.DependencyError{Service: "identity", Code: code, Retryable: retryable, Cause: errors.Join(causes...)}
}

func dependencyCode(err error) string {
	var failure *ports.DependencyError
	if errors.As(err, &failure) {
		return failure.Code
	}
	return "internal_error"
}

func dependencyObservation(err error) (string, string) {
	if err == nil {
		return "success", "none"
	}
	return "error", dependencyCode(err)
}

func mustCounter(counter metric.Int64Counter, err error) metric.Int64Counter {
	if err != nil {
		panic(err)
	}
	return counter
}

func mustHistogram(histogram metric.Float64Histogram, err error) metric.Float64Histogram {
	if err != nil {
		panic(err)
	}
	return histogram
}
