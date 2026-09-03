package identity

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

const maximumResponseBytes = 2 << 20

var tracer = otel.Tracer("soft/antnest-platform/edge-gateway/identity-client")

type Principal struct {
	UserID           string `json:"user_id"`
	OrganizationID   string `json:"organization_id"`
	MembershipID     string `json:"membership_id"`
	SystemRole       string `json:"system_role"`
	OrganizationRole string `json:"organization_role"`
	Active           bool   `json:"active"`
}

func (principal Principal) Administrator() bool {
	return principal.Active &&
		(principal.SystemRole == "admin" || principal.OrganizationRole == "admin")
}

type LoginInput struct {
	RequestID        string `json:"request_id"`
	OrganizationSlug string `json:"organization_slug"`
	Email            string `json:"email"`
	Password         string `json:"password"`
}

type LoginResult struct {
	Principal   Principal `json:"principal"`
	TokenID     string    `json:"token_id"`
	AccessToken string    `json:"access_token"`
	ExpiresAt   time.Time `json:"expires_at"`
}

type LoginMethod struct {
	Name        string `json:"name"`
	DisplayName string `json:"display_name"`
}

type StartOIDCLoginInput struct {
	RequestID        string `json:"request_id"`
	OrganizationSlug string `json:"organization_slug"`
	ProviderName     string `json:"provider_name"`
}

type StartOIDCLoginResult struct {
	AuthorizationURL string    `json:"authorization_url"`
	ExpiresAt        time.Time `json:"expires_at"`
}

type OIDCCallbackInput struct {
	State              string
	Code               string
	AuthorizationError string
}

type OIDCCallbackResult struct {
	Principal        Principal `json:"principal"`
	TokenID          string    `json:"token_id"`
	AccessToken      string    `json:"access_token,omitempty"`
	AlreadyCompleted bool      `json:"already_completed,omitempty"`
	ExpiresAt        time.Time `json:"expires_at"`
}

type RevokeStatus string

const (
	RevokeStatusRevoked        RevokeStatus = "revoked"
	RevokeStatusAlreadyInvalid RevokeStatus = "already_invalid"
)

type Client struct {
	base       *url.URL
	httpClient *http.Client
}

func NewClient(rawBaseURL string, httpClient *http.Client) (*Client, error) {
	base, err := url.Parse(strings.TrimSpace(rawBaseURL))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return nil, fmt.Errorf("identity service URL is invalid")
	}
	if base.RawQuery != "" || base.Fragment != "" {
		return nil, fmt.Errorf("identity service URL must not contain query or fragment")
	}
	if httpClient == nil {
		return nil, fmt.Errorf("identity HTTP client is required")
	}
	return &Client{base: base, httpClient: httpClient}, nil
}

func (client *Client) Login(ctx context.Context, input LoginInput) (LoginResult, error) {
	var result LoginResult
	err := client.doJSON(ctx, "login", http.MethodPost, "/rpc/identity/local-login", input, &result)
	return result, err
}

func (client *Client) ListLoginMethods(ctx context.Context, organizationSlug string) ([]LoginMethod, error) {
	var result struct {
		Methods []LoginMethod `json:"methods"`
	}
	err := client.doJSON(ctx, "list_login_methods", http.MethodPost,
		"/rpc/identity/list-login-methods", map[string]string{
			"organization_slug": organizationSlug,
		}, &result)
	return result.Methods, err
}

func (client *Client) StartOIDCLogin(
	ctx context.Context, input StartOIDCLoginInput,
) (StartOIDCLoginResult, error) {
	var result StartOIDCLoginResult
	err := client.doJSON(ctx, "start_oidc_login", http.MethodPost,
		"/rpc/identity/start-oidc-login", input, &result)
	return result, err
}

func (client *Client) CompleteOIDCLogin(
	ctx context.Context, input OIDCCallbackInput,
) (OIDCCallbackResult, error) {
	query := url.Values{"state": []string{input.State}}
	if input.Code != "" {
		query.Set("code", input.Code)
	}
	if input.AuthorizationError != "" {
		query.Set("error", input.AuthorizationError)
	}
	target := client.base.ResolveReference(&url.URL{
		Path: "/protocol/oidc/callback", RawQuery: query.Encode(),
	})
	var result OIDCCallbackResult
	err := client.doRequest(ctx, "complete_oidc_login", http.MethodGet, target, nil, &result)
	return result, err
}

func (client *Client) Resolve(ctx context.Context, accessToken string) (Principal, error) {
	var result struct {
		Principal Principal `json:"principal"`
	}
	err := client.doJSON(ctx, "resolve", http.MethodPost, "/rpc/identity/resolve-access-token",
		map[string]string{"access_token": accessToken}, &result)
	return result.Principal, err
}

func (client *Client) RevokeByAccessToken(
	ctx context.Context, accessToken string,
) (RevokeStatus, error) {
	var result struct {
		Status RevokeStatus `json:"status"`
	}
	err := client.doJSON(ctx, "revoke", http.MethodPost, "/rpc/identity/revoke-access-token",
		map[string]string{"access_token": accessToken}, &result)
	if err != nil {
		return "", err
	}
	if result.Status != RevokeStatusRevoked && result.Status != RevokeStatusAlreadyInvalid {
		return "", fmt.Errorf("identity service returned an invalid revoke status")
	}
	return result.Status, nil
}

func (client *Client) Ready(ctx context.Context) error {
	return client.doJSON(ctx, "status", http.MethodGet, "/status", nil, nil)
}

func (client *Client) doJSON(
	ctx context.Context,
	operation string,
	method string,
	path string,
	input any,
	output any,
) error {
	target := client.base.ResolveReference(&url.URL{Path: path})
	return client.doRequest(ctx, operation, method, target, input, output)
}

func (client *Client) doRequest(
	ctx context.Context,
	operation string,
	method string,
	target *url.URL,
	input any,
	output any,
) error {
	ctx, span := tracer.Start(ctx, "identity."+operation, trace.WithSpanKind(trace.SpanKindClient))
	defer span.End()
	span.SetAttributes(attribute.String("rpc.system", "http"), attribute.String("rpc.method", operation))

	var body io.Reader
	if input != nil {
		payload, err := json.Marshal(input)
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, "encode request")
			return fmt.Errorf("encode identity request: %w", err)
		}
		body = bytes.NewReader(payload)
	}
	request, err := http.NewRequestWithContext(ctx, method, target.String(), body)
	if err != nil {
		return fmt.Errorf("create identity request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(request.Header))

	response, err := client.httpClient.Do(request)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "transport failure")
		return fmt.Errorf("identity service unavailable: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	payload, err := io.ReadAll(io.LimitReader(response.Body, maximumResponseBytes+1))
	if err != nil {
		return fmt.Errorf("read identity response: %w", err)
	}
	if len(payload) > maximumResponseBytes {
		return fmt.Errorf("identity response exceeds limit")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		remote := &RemoteError{StatusCode: response.StatusCode, Code: "identity_error", Message: "Identity request failed"}
		_ = json.Unmarshal(payload, remote)
		span.SetStatus(codes.Error, remote.Code)
		return remote
	}
	if output == nil || response.StatusCode == http.StatusNoContent {
		return nil
	}
	if err := json.Unmarshal(payload, output); err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "invalid response")
		return fmt.Errorf("decode identity response: %w", err)
	}
	return nil
}

type RemoteError struct {
	StatusCode int    `json:"-"`
	Code       string `json:"code"`
	Message    string `json:"message"`
	Retryable  bool   `json:"retryable"`
}

func (err *RemoteError) Error() string {
	if err == nil {
		return "identity request failed"
	}
	return fmt.Sprintf("identity request failed: %s", err.Code)
}

func IsCode(err error, code string) bool {
	var remote *RemoteError
	return errors.As(err, &remote) && remote.Code == code
}
