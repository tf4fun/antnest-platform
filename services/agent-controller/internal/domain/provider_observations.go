package domain

import (
	"bytes"
	"encoding/json"
	"errors"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

var ErrInvalidProviderObservation = errors.New("provider observation is invalid")

// Provider observation bounds mirror the shared safe-integer contract: JSON
// consumers must never see values outside the exact-integer range.
const MaximumSafeInteger int64 = 9007199254740991

// ProviderTokenLimitsSource is the only accepted provenance for trusted
// observed bounds; editable model or template values never emit it.
const ProviderTokenLimitsSource = "models"

// ProviderObservationBinding is only authoritative while every field still
// matches the current saved connection, including the STRING credential
// version, so rotation immediately invalidates the set.
type ProviderObservationBinding struct {
	OrganizationID     string `json:"organization_id"`
	ConnectionID       string `json:"connection_id"`
	ProviderKey        string `json:"provider_key"`
	RequestProtocol    string `json:"request_protocol"`
	BaseURL            string `json:"base_url"`
	CredentialRevision string `json:"credential_revision"`
}

// ProviderObservedModel is one discovered model; Model is the provider's
// exact API id, never a profile alias.
type ProviderObservedModel struct {
	Model           string `json:"model"`
	ContextTokens   *int64 `json:"context_tokens,omitempty"`
	MaxOutputTokens *int64 `json:"max_output_tokens,omitempty"`
	SupportsTools   *bool  `json:"supports_tools,omitempty"`
}

// ProviderObservationSet is the whitelisted durable result of one saved
// discovery: its binding plus the complete observed model list.
type ProviderObservationSet struct {
	Binding        ProviderObservationBinding `json:"binding"`
	SourceRevision int64                      `json:"source_revision"`
	Models         []ProviderObservedModel    `json:"models"`
}

// ProviderTokenLimitBinding emits the connection binding plus the exact API
// model id the limits describe.
type ProviderTokenLimitBinding struct {
	ProviderObservationBinding
	Model string `json:"model"`
}

// ProviderTokenLimits is emitted only when at least one dimension was
// observed; editable ContextWindow/MaxOutputTokens cannot fill unknowns.
type ProviderTokenLimits struct {
	Source          string                    `json:"source"`
	SourceRevision  int64                     `json:"source_revision"`
	Binding         ProviderTokenLimitBinding `json:"binding"`
	ContextTokens   *int64                    `json:"context_tokens,omitempty"`
	MaxOutputTokens *int64                    `json:"max_output_tokens,omitempty"`
}

// CanonicalProviderBaseURL normalizes a Provider base URL for binding
// comparison: lower-cased scheme/host, default port dropped, every trailing
// '/' collapsed to a single root '/', escaped path preserved verbatim and
// IPv6 brackets retained.
func CanonicalProviderBaseURL(raw string) (string, error) {
	endpoint, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || endpoint == nil || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" || endpoint.Opaque != "" {
		return "", ErrInvalidProviderObservation
	}
	scheme := strings.ToLower(endpoint.Scheme)
	if scheme != "https" && scheme != "http" {
		return "", ErrInvalidProviderObservation
	}
	host := strings.ToLower(endpoint.Hostname())
	if host == "" {
		return "", ErrInvalidProviderObservation
	}
	port := endpoint.Port()
	if port != "" {
		if number, err := strconv.Atoi(port); err != nil || number < 1 || number > 65535 {
			return "", ErrInvalidProviderObservation
		}
	}
	if (scheme == "https" && port == "443") || (scheme == "http" && port == "80") {
		port = ""
	}
	var netloc string
	if port != "" {
		netloc = net.JoinHostPort(host, port)
	} else if strings.Contains(host, ":") {
		netloc = "[" + host + "]"
	} else {
		netloc = host
	}
	path := strings.TrimRight(endpoint.EscapedPath(), "/")
	if path == "" {
		path = "/"
	}
	return scheme + "://" + netloc + path, nil
}

// Matches reports whether the binding still describes the current
// authoritative Provider connection. The request protocol is derived from
// SupportedProvider, never from an external payload, and the credential
// revision compares the STRING credential version.
func (binding ProviderObservationBinding) Matches(organizationID, connectionID, providerKey, requestProtocol, baseURL, credentialVersion string) bool {
	canonical, err := CanonicalProviderBaseURL(baseURL)
	if err != nil {
		return false
	}
	return binding.OrganizationID == organizationID &&
		binding.ConnectionID == connectionID &&
		binding.ProviderKey == providerKey &&
		binding.RequestProtocol == requestProtocol &&
		binding.BaseURL == canonical &&
		binding.CredentialRevision == credentialVersion
}

var observationIdentifier = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$`)

func validObservationIdentifier(value string) bool {
	return observationIdentifier.MatchString(value)
}

// Valid reports whether a binding itself has the canonical shared shape: a
// supported provider with its derived request protocol, an already-canonical
// base URL and the shared identifier grammar.
func (binding ProviderObservationBinding) Valid() bool {
	support, ok := SupportedProvider(binding.ProviderKey)
	if !ok || binding.RequestProtocol != support.RequestProtocol ||
		!validObservationIdentifier(binding.OrganizationID) ||
		!validObservationIdentifier(binding.ConnectionID) ||
		!validObservationIdentifier(binding.CredentialRevision) {
		return false
	}
	canonical, err := CanonicalProviderBaseURL(binding.BaseURL)
	return err == nil && canonical == binding.BaseURL
}

// ValidObservationSet reports whether a stored set only contains whitelisted
// facts with the canonical binding shape, a valid source revision and unique
// nonblank API ids with safe-integer bounds.
func (set ProviderObservationSet) ValidObservationSet() bool {
	if !set.Binding.Valid() || set.SourceRevision < 1 || set.SourceRevision > MaximumSafeInteger || set.Models == nil {
		return false
	}
	seen := make(map[string]bool, len(set.Models))
	for _, model := range set.Models {
		if strings.TrimSpace(model.Model) == "" || len(model.Model) > 200 || seen[model.Model] ||
			!safePositive(model.ContextTokens) || !safePositive(model.MaxOutputTokens) {
			return false
		}
		seen[model.Model] = true
	}
	return true
}

// DecodeObservationModels strictly decodes the stored models column; unknown
// fields or malformed entries fail closed.
func DecodeObservationModels(payload []byte) ([]ProviderObservedModel, error) {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	var models []ProviderObservedModel
	if err := decoder.Decode(&models); err != nil || models == nil || decoder.More() {
		return nil, ErrInvalidProviderObservation
	}
	return models, nil
}

func safePositive(value *int64) bool {
	return value == nil || (*value >= 1 && *value <= MaximumSafeInteger)
}
