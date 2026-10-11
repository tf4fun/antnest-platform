package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
)

// Dates stay strings until validation: the strict object decoder does not use
// custom struct unmarshallers, including time.Time's. Subject remains raw until
// we have ruled out encoding/json's Unicode replacement behavior.
type externalIdentityBindingSource struct {
	ID                  string          `json:"id"`
	ProviderID          string          `json:"provider_id"`
	ProviderName        string          `json:"provider_name"`
	ProviderDisplayName string          `json:"provider_display_name"`
	OrganizationID      string          `json:"organization_id"`
	OrganizationSlug    string          `json:"organization_slug"`
	OrganizationName    string          `json:"organization_name"`
	MembershipID        string          `json:"membership_id"`
	Subject             json.RawMessage `json:"subject"`
	Method              string          `json:"method"`
	ProviderEnabled     *bool           `json:"provider_enabled"`
	CreatedAt           string          `json:"created_at"`
	BoundAt             string          `json:"bound_at"`
	RevokedAt           json.RawMessage `json:"revoked_at"`
}

func (source externalIdentityBindingSource) validate(organization, membership string) error {
	if !browserSessionPublicID.MatchString(source.ID) || !browserSessionPublicID.MatchString(source.ProviderID) ||
		!browserSessionPublicID.MatchString(source.OrganizationID) || !browserSessionPublicID.MatchString(source.MembershipID) ||
		source.OrganizationID != organization || source.MembershipID != membership ||
		!externalIdentityDisplay(source.ProviderName) || !externalIdentityDisplay(source.ProviderDisplayName) ||
		!externalIdentityDisplay(source.OrganizationSlug) || !externalIdentityDisplay(source.OrganizationName) ||
		(source.Method != "auto" && source.Method != "admin" && source.Method != "scim") || source.ProviderEnabled == nil ||
		!externalIdentityDate(source.CreatedAt) || !externalIdentityDate(source.BoundAt) || source.RevokedAt == nil {
		return fmt.Errorf("invalid external identity metadata")
	}
	if _, err := parseExternalIdentitySubject(source.Subject); err != nil {
		return err
	}
	if !bytes.Equal(bytes.TrimSpace(source.RevokedAt), []byte("null")) {
		var date string
		if json.Unmarshal(source.RevokedAt, &date) != nil || !externalIdentityDate(date) {
			return fmt.Errorf("invalid external identity revocation timestamp")
		}
	}
	return nil
}

func externalIdentityDisplay(value string) bool { return strings.TrimFunc(value, oidcWhitespace) != "" }

var externalIdentityDatePattern = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?([Zz]|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$`)

func externalIdentityDate(value string) bool {
	if !externalIdentityDatePattern.MatchString(value) {
		return false
	}
	date, err := time.Parse(time.RFC3339Nano, strings.ToUpper(value))
	return err == nil && !date.IsZero()
}

func validateExternalIdentityCursor(raw json.RawMessage, after, last string) error {
	if raw == nil {
		return nil
	}
	var cursor string
	if json.Unmarshal(raw, &cursor) != nil || !browserSessionPublicID.MatchString(cursor) || cursor <= after || cursor < last {
		return fmt.Errorf("invalid external identity cursor")
	}
	return nil
}

func projectOrganizationExternalIdentities(body []byte, organization, membership, after string, limit int) ([]byte, error) {
	var page struct {
		Bindings    []externalIdentityBindingSource `json:"bindings"`
		NextAfterID json.RawMessage                 `json:"next_after_id,omitempty"`
	}
	if err := serviceauth.DecodeObject(body, &page); err != nil {
		return nil, err
	}
	if page.Bindings == nil || len(page.Bindings) > limit {
		return nil, fmt.Errorf("invalid external identity page")
	}
	previous := after
	for _, row := range page.Bindings {
		if err := row.validate(organization, membership); err != nil {
			return nil, err
		}
		if row.ID <= previous {
			return nil, fmt.Errorf("invalid external identity order")
		}
		previous = row.ID
	}
	if err := validateExternalIdentityCursor(page.NextAfterID, after, previous); err != nil {
		return nil, err
	}
	return json.Marshal(page)
}

func projectExternalIdentityBinding(body []byte, organization, membership, provider, subject string) ([]byte, error) {
	var result struct {
		Binding *externalIdentityBindingSource `json:"binding"`
	}
	if err := serviceauth.DecodeObject(body, &result); err != nil {
		return nil, err
	}
	if result.Binding == nil {
		return nil, fmt.Errorf("external identity binding is required")
	}
	if err := result.Binding.validate(organization, membership); err != nil {
		return nil, err
	}
	actualSubject, err := parseExternalIdentitySubject(result.Binding.Subject)
	if err != nil || actualSubject != subject || result.Binding.ProviderID != provider {
		return nil, fmt.Errorf("external identity binding does not match command")
	}
	return json.Marshal(result)
}

type externalIdentityProviderSource struct {
	oidcPolicySource
	ID          string `json:"id"`
	Name        string `json:"name"`
	DisplayName string `json:"display_name"`
	Enabled     *bool  `json:"enabled"`
}

func projectExternalIdentityProviders(body []byte, after string, limit int) ([]byte, error) {
	var page struct {
		Providers   []externalIdentityProviderSource `json:"providers"`
		NextAfterID json.RawMessage                  `json:"next_after_id,omitempty"`
	}
	if err := serviceauth.DecodeObject(body, &page); err != nil {
		return nil, err
	}
	if page.Providers == nil || len(page.Providers) > limit {
		return nil, fmt.Errorf("invalid external identity provider page")
	}
	previous := after
	for _, row := range page.Providers {
		if !browserSessionPublicID.MatchString(row.ID) || row.ID <= previous || !externalIdentityDisplay(row.Name) || !externalIdentityDisplay(row.DisplayName) || row.Enabled == nil {
			return nil, fmt.Errorf("invalid provider chooser metadata")
		}
		if err := row.validate(); err != nil {
			return nil, err
		}
		previous = row.ID
	}
	if err := validateExternalIdentityCursor(page.NextAfterID, after, previous); err != nil {
		return nil, err
	}
	return json.Marshal(page)
}

func projectExternalIdentityUnbind(body []byte, self bool) ([]byte, error) {
	var result struct {
		RevokedCount   *int  `json:"revoked_count"`
		CurrentRevoked *bool `json:"current_revoked"`
	}
	if err := serviceauth.DecodeObject(body, &result); err != nil {
		return nil, err
	}
	if result.RevokedCount == nil || result.CurrentRevoked == nil || *result.RevokedCount < 0 || *result.CurrentRevoked && (!self || *result.RevokedCount == 0) {
		return nil, fmt.Errorf("invalid external identity revocation result")
	}
	return json.Marshal(result)
}
