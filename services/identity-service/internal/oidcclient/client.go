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

	"soft/antnest-platform/services/identity-service/internal/oidcflow"
)

const responseLimit = 1 << 20

type Client struct{ httpClient *http.Client }

func New(httpClient *http.Client) (*Client, error) {
	if httpClient == nil {
		return nil, fmt.Errorf("OIDC client requires an HTTP client")
	}
	return &Client{httpClient: httpClient}, nil
}

func (c *Client) Discover(ctx context.Context, issuer string) (oidcflow.Discovery, error) {
	provider, err := oidc.NewProvider(oidc.ClientContext(ctx, c.httpClient), issuer)
	if err != nil {
		return oidcflow.Discovery{}, fmt.Errorf("discover OIDC metadata: %w", err)
	}
	var metadata struct {
		Issuer           string `json:"issuer"`
		UserInfoEndpoint string `json:"userinfo_endpoint"`
		JWKSURI          string `json:"jwks_uri"`
	}
	if err := provider.Claims(&metadata); err != nil {
		return oidcflow.Discovery{}, fmt.Errorf("decode OIDC metadata: %w", err)
	}
	endpoint := provider.Endpoint()
	return oidcflow.Discovery{
		Issuer: metadata.Issuer, AuthorizationEndpoint: endpoint.AuthURL,
		TokenEndpoint: endpoint.TokenURL, UserInfoEndpoint: metadata.UserInfoEndpoint,
		JWKSURI: metadata.JWKSURI,
	}, nil
}

func (c *Client) AuthorizationURL(input oidcflow.AuthorizationInput) (string, error) {
	config := oauth2.Config{
		ClientID:    input.Provider.ClientID,
		Endpoint:    oauth2.Endpoint{AuthURL: input.Provider.AuthorizationEndpoint},
		RedirectURL: input.Provider.RedirectURI,
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
) (oidcflow.VerifiedIdentity, error) {
	config := oauth2.Config{
		ClientID:     input.Provider.ClientID,
		ClientSecret: input.ClientSecret,
		Endpoint: oauth2.Endpoint{
			AuthURL: input.Provider.AuthorizationEndpoint, TokenURL: input.Provider.TokenEndpoint,
		},
		RedirectURL: input.Provider.RedirectURI,
		Scopes:      input.Provider.Scopes,
	}
	requestContext := oidc.ClientContext(ctx, c.httpClient)
	token, err := config.Exchange(requestContext, input.Code, oauth2.VerifierOption(input.PKCEVerifier))
	if err != nil {
		return oidcflow.VerifiedIdentity{}, fmt.Errorf("exchange OIDC authorization code: %w", err)
	}
	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok || strings.TrimSpace(rawIDToken) == "" {
		return oidcflow.VerifiedIdentity{}, fmt.Errorf("OIDC token response has no id_token")
	}
	verifier := oidc.NewVerifier(
		input.Provider.Issuer,
		oidc.NewRemoteKeySet(requestContext, input.Provider.JWKSURI),
		&oidc.Config{ClientID: input.Provider.ClientID},
	)
	idToken, err := verifier.Verify(requestContext, rawIDToken)
	if err != nil {
		return oidcflow.VerifiedIdentity{}, fmt.Errorf("verify OIDC id_token: %w", err)
	}
	var claims struct {
		Nonce             string `json:"nonce"`
		Email             string `json:"email"`
		EmailVerified     bool   `json:"email_verified"`
		Name              string `json:"name"`
		PreferredUsername string `json:"preferred_username"`
	}
	if err := idToken.Claims(&claims); err != nil {
		return oidcflow.VerifiedIdentity{}, fmt.Errorf("decode OIDC id_token claims: %w", err)
	}
	if claims.Nonce != input.Nonce {
		return oidcflow.VerifiedIdentity{}, fmt.Errorf("OIDC nonce mismatch")
	}
	identity := oidcflow.VerifiedIdentity{
		Issuer: idToken.Issuer, Subject: idToken.Subject, Email: claims.Email,
		EmailVerified: claims.EmailVerified,
		DisplayName:   firstNonempty(claims.Name, claims.PreferredUsername),
	}
	if input.Provider.UserInfoEndpoint == "" || token.AccessToken == "" {
		return identity, nil
	}
	return c.mergeUserInfo(requestContext, input.Provider.UserInfoEndpoint, token.AccessToken, identity)
}

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
		Subject           string `json:"sub"`
		Email             string `json:"email"`
		EmailVerified     *bool  `json:"email_verified"`
		Name              string `json:"name"`
		PreferredUsername string `json:"preferred_username"`
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, responseLimit))
	if err := decoder.Decode(&userInfo); err != nil {
		return oidcflow.VerifiedIdentity{}, fmt.Errorf("decode OIDC UserInfo: %w", err)
	}
	if userInfo.Subject == "" || userInfo.Subject != identity.Subject {
		return oidcflow.VerifiedIdentity{}, fmt.Errorf("OIDC UserInfo subject does not match id_token")
	}
	userInfoEmail := strings.TrimSpace(userInfo.Email)
	if userInfoEmail != "" {
		if !strings.EqualFold(userInfoEmail, strings.TrimSpace(identity.Email)) && userInfo.EmailVerified == nil {
			identity.EmailVerified = false
		}
		identity.Email = userInfoEmail
	}
	identity.DisplayName = firstNonempty(userInfo.Name, userInfo.PreferredUsername, identity.DisplayName)
	if userInfoEmail != "" && userInfo.EmailVerified != nil {
		identity.EmailVerified = *userInfo.EmailVerified
	}
	return identity, nil
}

func firstNonempty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}
