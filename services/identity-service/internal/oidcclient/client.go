package oidcclient

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/oidcflow"
)

const responseLimit = 1 << 20

var errResponseTooLarge = errors.New("OIDC response exceeds 1 MiB")

type Client struct{ httpClient *http.Client }

func New(httpClient *http.Client) (*Client, error) {
	if httpClient == nil {
		return nil, fmt.Errorf("OIDC client requires an HTTP client")
	}
	bounded := *httpClient
	transport := bounded.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}
	bounded.Transport = responseLimitTransport{base: transport, limit: responseLimit}
	bounded.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &Client{httpClient: &bounded}, nil
}

func (c *Client) Discover(ctx context.Context, issuer string) (_ oidcflow.Discovery, resultErr error) {
	ctx, finish := startOperation(ctx, "identity.oidc.discover")
	defer func() { finish(resultErr) }()
	provider, err := oidc.NewProvider(oidc.ClientContext(ctx, c.httpClient), issuer)
	if err != nil {
		if strings.Contains(err.Error(), errResponseTooLarge.Error()) {
			err = errResponseTooLarge
		}
		return oidcflow.Discovery{}, fmt.Errorf("discover OIDC metadata: %w", err)
	}
	var metadata struct {
		Issuer                   string   `json:"issuer"`
		UserInfoEndpoint         string   `json:"userinfo_endpoint"`
		JWKSURI                  string   `json:"jwks_uri"`
		TokenEndpointAuthMethods []string `json:"token_endpoint_auth_methods_supported"`
		IDTokenSigningAlgs       []string `json:"id_token_signing_alg_values_supported"`
	}
	if err := provider.Claims(&metadata); err != nil {
		return oidcflow.Discovery{}, fmt.Errorf("decode OIDC metadata: %w", err)
	}
	endpoint := provider.Endpoint()
	return oidcflow.Discovery{
		Issuer: metadata.Issuer, AuthorizationEndpoint: endpoint.AuthURL,
		TokenEndpoint: endpoint.TokenURL, UserInfoEndpoint: metadata.UserInfoEndpoint,
		JWKSURI: metadata.JWKSURI, TokenEndpointAuthMethods: metadata.TokenEndpointAuthMethods,
		IDTokenSigningAlgs: metadata.IDTokenSigningAlgs,
	}, nil
}

func (c *Client) AuthorizationURL(input oidcflow.AuthorizationInput) (string, error) {
	config := oauth2.Config{
		ClientID:    input.Provider.ClientID,
		Endpoint:    oauth2.Endpoint{AuthURL: input.Provider.AuthorizationEndpoint},
		RedirectURL: input.RedirectURI,
		Scopes:      input.Provider.Scopes,
	}
	return config.AuthCodeURL(
		input.State,
		oidc.Nonce(input.Nonce),
		oauth2.SetAuthURLParam("code_challenge", input.PKCEChallenge),
		oauth2.SetAuthURLParam("code_challenge_method", "S256"),
	), nil
}

func (c *Client) ExchangeAndVerify(
	ctx context.Context,
	input oidcflow.ExchangeInput,
) (_ oidcflow.ExchangeResult, resultErr error) {
	ctx, finish := startOperation(ctx, "identity.oidc.exchange_verify")
	defer func() { finish(resultErr) }()
	providerFacts(ctx, input.Provider)
	authStyle, err := tokenEndpointAuthStyle(input.Provider.TokenEndpointAuthMethod)
	if err != nil {
		return oidcflow.ExchangeResult{}, err
	}
	config := oauth2.Config{
		ClientID:     input.Provider.ClientID,
		ClientSecret: input.ClientSecret,
		Endpoint: oauth2.Endpoint{
			AuthURL: input.Provider.AuthorizationEndpoint, TokenURL: input.Provider.TokenEndpoint,
			AuthStyle: authStyle,
		},
		RedirectURL: input.RedirectURI,
		Scopes:      input.Provider.Scopes,
	}
	requestContext := oidc.ClientContext(ctx, c.httpClient)
	token, err := config.Exchange(requestContext, input.Code, oauth2.VerifierOption(input.PKCEVerifier))
	if err != nil {
		return oidcflow.ExchangeResult{}, fmt.Errorf("exchange OIDC authorization code: %w", err)
	}
	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok || strings.TrimSpace(rawIDToken) == "" {
		return oidcflow.ExchangeResult{}, fmt.Errorf("OIDC token response has no id_token")
	}
	verifier := oidc.NewVerifier(
		input.Provider.Issuer,
		oidc.NewRemoteKeySet(requestContext, input.Provider.JWKSURI),
		&oidc.Config{ClientID: input.Provider.ClientID, SupportedSigningAlgs: input.Provider.IDTokenSigningAlgs},
	)
	idToken, err := verifier.Verify(requestContext, rawIDToken)
	if err != nil {
		return oidcflow.ExchangeResult{}, fmt.Errorf("verify OIDC id_token: %w", err)
	}
	var claims struct {
		Subject           json.RawMessage `json:"sub"`
		Nonce             string          `json:"nonce"`
		Email             json.RawMessage `json:"email"`
		EmailVerified     json.RawMessage `json:"email_verified"`
		Name              json.RawMessage `json:"name"`
		PreferredUsername json.RawMessage `json:"preferred_username"`
	}
	if err := idToken.Claims(&claims); err != nil {
		return oidcflow.ExchangeResult{}, fmt.Errorf("decode OIDC id_token claims: %w", err)
	}
	if claims.Nonce != input.Nonce {
		return oidcflow.ExchangeResult{}, fmt.Errorf("OIDC nonce mismatch")
	}
	subject, err := oidcflow.ParseSubjectJSON(claims.Subject)
	if err != nil || subject != idToken.Subject {
		return oidcflow.ExchangeResult{}, fmt.Errorf("invalid OIDC id_token subject")
	}
	identity := oidcflow.VerifiedIdentity{
		Issuer: idToken.Issuer, Subject: subject, Email: optionalString(claims.Email),
		DisplayName: firstNonempty(optionalString(claims.Name), optionalString(claims.PreferredUsername)),
	}
	if verified := optionalBoolean(claims.EmailVerified); verified != nil {
		identity.EmailVerified = *verified
	}
	return oidcflow.ExchangeResult{Identity: identity, UserInfoAccessToken: token.AccessToken}, nil
}

func (c *Client) FetchUserInfo(ctx context.Context, input oidcflow.UserInfoInput) (oidcflow.VerifiedIdentity, error) {
	return c.mergeUserInfo(ctx, input.Endpoint, input.AccessToken, input.Identity)
}

func tokenEndpointAuthStyle(method string) (oauth2.AuthStyle, error) {
	switch method {
	case "client_secret_basic":
		return oauth2.AuthStyleInHeader, nil
	case "client_secret_post":
		return oauth2.AuthStyleInParams, nil
	default:
		return oauth2.AuthStyleAutoDetect, fmt.Errorf("unsupported OIDC token endpoint auth method %q", method)
	}
}

type responseLimitTransport struct {
	base  http.RoundTripper
	limit int64
}

func (t responseLimitTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	response, err := t.base.RoundTrip(request)
	if err != nil {
		return nil, err
	}
	if response.ContentLength > t.limit {
		_ = response.Body.Close()
		return nil, errResponseTooLarge
	}
	response.Body = &responseLimitBody{body: response.Body, remaining: t.limit}
	return response, nil
}

type responseLimitBody struct {
	body      io.ReadCloser
	remaining int64
}

func (b *responseLimitBody) Read(buffer []byte) (int, error) {
	if b.remaining == 0 {
		var probe [1]byte
		read, err := b.body.Read(probe[:])
		if read > 0 {
			return 0, errResponseTooLarge
		}
		return 0, err
	}
	if int64(len(buffer)) > b.remaining {
		buffer = buffer[:b.remaining]
	}
	read, err := b.body.Read(buffer)
	b.remaining -= int64(read)
	return read, err
}

func (b *responseLimitBody) Close() error { return b.body.Close() }

func (c *Client) mergeUserInfo(
	ctx context.Context,
	endpoint string,
	accessToken string,
	identity oidcflow.VerifiedIdentity,
) (_ oidcflow.VerifiedIdentity, returnErr error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return oidcflow.VerifiedIdentity{}, fmt.Errorf("create OIDC UserInfo request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+accessToken)
	response, err := c.httpClient.Do(request)
	if err != nil {
		return oidcflow.VerifiedIdentity{}, fmt.Errorf("fetch OIDC UserInfo: %w", err)
	}
	defer func() { returnErr = errors.Join(returnErr, response.Body.Close()) }()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return oidcflow.VerifiedIdentity{}, fmt.Errorf("fetch OIDC UserInfo: provider returned HTTP %d", response.StatusCode)
	}
	var userInfo struct {
		Subject           json.RawMessage `json:"sub"`
		Email             json.RawMessage `json:"email"`
		EmailVerified     json.RawMessage `json:"email_verified"`
		Name              json.RawMessage `json:"name"`
		PreferredUsername json.RawMessage `json:"preferred_username"`
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, responseLimit))
	if err := decoder.Decode(&userInfo); err != nil {
		return oidcflow.VerifiedIdentity{}, fmt.Errorf("decode OIDC UserInfo: %w", err)
	}
	subject, err := oidcflow.ParseSubjectJSON(userInfo.Subject)
	if err != nil || subject != identity.Subject {
		return oidcflow.VerifiedIdentity{}, fmt.Errorf("OIDC UserInfo subject does not match id_token")
	}
	userInfoEmail := strings.TrimSpace(optionalString(userInfo.Email))
	userInfoVerified := optionalBoolean(userInfo.EmailVerified)
	if userInfoEmail != "" {
		if !strings.EqualFold(userInfoEmail, strings.TrimSpace(identity.Email)) && userInfoVerified == nil {
			identity.EmailVerified = false
		}
		identity.Email = userInfoEmail
	}
	identity.DisplayName = firstNonempty(optionalString(userInfo.Name), optionalString(userInfo.PreferredUsername), identity.DisplayName)
	if userInfoEmail != "" && userInfoVerified != nil {
		identity.EmailVerified = *userInfoVerified
	}
	return identity, nil
}

// Optional profile claims never decide whether a verified issuer/subject can
// be used. Type errors are absence, and are never coerced into email authority.
func optionalString(raw json.RawMessage) string {
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return ""
	}
	return value
}

func optionalBoolean(raw json.RawMessage) *bool {
	var value *bool
	if json.Unmarshal(raw, &value) != nil {
		return nil
	}
	return value
}

func firstNonempty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}
