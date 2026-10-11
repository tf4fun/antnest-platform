package server

import (
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
)

// Raw fields distinguish omission (preserve the stored policy) from null and
// explicit false. An ACK, including false, requires the complete policy tuple.
type oidcPolicyInput struct {
	LinkPolicy                  json.RawMessage `json:"link_policy"`
	LinkDomains                 json.RawMessage `json:"link_domains"`
	Authoritative               json.RawMessage `json:"authoritative"`
	AcknowledgeLinkPolicyReview json.RawMessage `json:"acknowledge_link_policy_review"`
}

func (input oidcPolicyInput) policyFields() (map[string]any, error) {
	if len(input.LinkPolicy) == 0 && len(input.LinkDomains) == 0 && len(input.Authoritative) == 0 && len(input.AcknowledgeLinkPolicyReview) == 0 {
		return nil, nil
	}
	var policy *string
	var domains *[]string
	var authoritative *bool
	if json.Unmarshal(input.LinkPolicy, &policy) != nil || json.Unmarshal(input.LinkDomains, &domains) != nil ||
		json.Unmarshal(input.Authoritative, &authoritative) != nil || policy == nil || domains == nil || authoritative == nil {
		return nil, fmt.Errorf("complete non-null linking policy required")
	}
	canonical, err := canonicalLinkDomains(*policy, *domains)
	if err != nil {
		return nil, err
	}
	fields := map[string]any{"link_policy": *policy, "link_domains": canonical, "authoritative": *authoritative}
	if len(input.AcknowledgeLinkPolicyReview) != 0 {
		var acknowledge *bool
		if json.Unmarshal(input.AcknowledgeLinkPolicyReview, &acknowledge) != nil || acknowledge == nil {
			return nil, fmt.Errorf("non-null policy review ACK required")
		}
		fields["acknowledge_link_policy_review"] = *acknowledge
	}
	return fields, nil
}

type oidcPolicySource struct {
	LinkPolicy               *string   `json:"link_policy"`
	LinkDomains              *[]string `json:"link_domains"`
	Authoritative            *bool     `json:"authoritative"`
	LinkPolicyReviewRequired *bool     `json:"link_policy_review_required"`
}

func (source oidcPolicySource) validate() error {
	if source.LinkPolicy == nil || source.LinkDomains == nil || source.Authoritative == nil || source.LinkPolicyReviewRequired == nil {
		return fmt.Errorf("incomplete linking policy metadata")
	}
	canonical, err := canonicalLinkDomains(*source.LinkPolicy, *source.LinkDomains)
	if err != nil || !slices.Equal(canonical, *source.LinkDomains) {
		return fmt.Errorf("invalid linking policy metadata")
	}
	return nil
}

var oidcDomainLabel = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

func canonicalLinkDomains(policy string, domains []string) ([]string, error) {
	if policy != "none" && policy != "verified_email" && policy != "verified_email_in_domains" ||
		len(domains) > 100 || (policy == "verified_email_in_domains") != (len(domains) > 0) {
		return nil, fmt.Errorf("invalid linking policy or domain count")
	}
	canonical := make([]string, 0, len(domains))
	seen := make(map[string]bool, len(domains))
	for _, raw := range domains {
		if !utf8.ValidString(raw) || utf8.RuneCountInString(raw) > 255 {
			return nil, fmt.Errorf("invalid linking domain")
		}
		domain := strings.TrimFunc(raw, oidcWhitespace)
		for _, r := range domain {
			if r > 127 {
				return nil, fmt.Errorf("linking domain must be ASCII")
			}
		}
		domain = strings.ToLower(domain)
		if domain == "" || len(domain) > 253 || seen[domain] {
			return nil, fmt.Errorf("invalid or duplicate linking domain")
		}
		for _, label := range strings.Split(domain, ".") {
			if !oidcDomainLabel.MatchString(label) {
				return nil, fmt.Errorf("invalid DNS domain")
			}
		}
		canonical, seen[domain] = append(canonical, domain), true
	}
	return canonical, nil
}

// Shared ECMAScript trim: FEFF is whitespace; NEL (0085) is not.
func oidcWhitespace(r rune) bool {
	return r >= '\u0009' && r <= '\u000d' || r == '\u0020' || r == '\u00a0' || r == '\u1680' ||
		r >= '\u2000' && r <= '\u200a' || r == '\u2028' || r == '\u2029' || r == '\u202f' ||
		r == '\u205f' || r == '\u3000' || r == '\ufeff'
}

// Existing provisioning responses contain internal fields that the BFF omits.
// Keep that allowlist while rejecting duplicate JSON and aliases of security
// metadata; Go's case-insensitive struct decoder must not override these fields.
func decodeProvisioningMetadata(payload []byte, target any, names ...string) error {
	var fields map[string]json.RawMessage
	if err := serviceauth.DecodeObject(payload, &fields); err != nil {
		return err
	}
	for key := range fields {
		for _, name := range names {
			if key != name && strings.EqualFold(key, name) {
				return fmt.Errorf("ambiguous provisioning metadata")
			}
		}
	}
	return json.Unmarshal(payload, target)
}

func (source *oidcProviderSource) UnmarshalJSON(payload []byte) error {
	type wire oidcProviderSource
	return decodeProvisioningMetadata(payload, (*wire)(source), "link_policy", "link_domains", "authoritative", "link_policy_review_required")
}

func (source *scimTokenSource) UnmarshalJSON(payload []byte) error {
	type wire scimTokenSource
	return decodeProvisioningMetadata(payload, (*wire)(source), "oidc_provider_id")
}
