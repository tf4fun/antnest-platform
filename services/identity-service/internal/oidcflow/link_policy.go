package oidcflow

import (
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

const (
	LinkPolicyNone                   = "none"
	LinkPolicyVerifiedEmail          = "verified_email"
	LinkPolicyVerifiedEmailInDomains = "verified_email_in_domains"
)

var domainLabel = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

func providerPolicy(existing Provider, input UpsertProviderInput) (Provider, error) {
	policy := existing
	if policy.LinkPolicy == "" {
		policy.LinkPolicy = LinkPolicyNone
	}
	policy.LinkDomains = append([]string{}, existing.LinkDomains...)
	fields := 0
	if input.LinkPolicy != nil {
		fields++
	}
	if input.LinkDomains != nil {
		fields++
	}
	if input.Authoritative != nil {
		fields++
	}
	if fields == 0 && input.AcknowledgeLinkPolicyReview == nil {
		return policy, nil
	}
	if fields != 3 {
		return Provider{}, domain.InvalidArgument("link_policy, link_domains and authoritative must be supplied together")
	}
	policy.LinkPolicy, policy.Authoritative = *input.LinkPolicy, *input.Authoritative
	if policy.LinkPolicy != LinkPolicyNone && policy.LinkPolicy != LinkPolicyVerifiedEmail && policy.LinkPolicy != LinkPolicyVerifiedEmailInDomains {
		return Provider{}, domain.InvalidArgument("link_policy is invalid")
	}
	values := *input.LinkDomains
	if len(values) > 100 || (policy.LinkPolicy == LinkPolicyVerifiedEmailInDomains) != (len(values) > 0) {
		return Provider{}, domain.InvalidArgument("link_domains must contain 1–100 exact domains only for verified_email_in_domains")
	}
	policy.LinkDomains = make([]string, 0, len(values))
	seen := make(map[string]bool)
	for _, raw := range values {
		if !utf8.ValidString(raw) || utf8.RuneCountInString(raw) > 255 {
			return Provider{}, domain.InvalidArgument("link domain is too long")
		}
		value := strings.TrimFunc(raw, domainWhitespace)
		for _, r := range value {
			if r > 127 {
				return Provider{}, domain.InvalidArgument("link domains must use ASCII A-labels")
			}
		}
		value = strings.ToLower(value)
		if len(value) == 0 || len(value) > 253 || seen[value] {
			return Provider{}, domain.InvalidArgument("link domains must be distinct exact DNS domains")
		}
		for _, label := range strings.Split(value, ".") {
			if !domainLabel.MatchString(label) {
				return Provider{}, domain.InvalidArgument("link domains must be exact ASCII DNS domains")
			}
		}
		seen[value] = true
		policy.LinkDomains = append(policy.LinkDomains, value)
	}
	if input.AcknowledgeLinkPolicyReview != nil && *input.AcknowledgeLinkPolicyReview {
		policy.LinkPolicyReviewRequired = false
	}
	return policy, nil
}

// Keep domain normalization aligned with the shared ECMAScript trim set.
// In particular, U+FEFF is whitespace here and U+0085 is not.
func domainWhitespace(r rune) bool {
	return r >= '\u0009' && r <= '\u000d' || r == '\u0020' || r == '\u00a0' || r == '\u1680' ||
		r >= '\u2000' && r <= '\u200a' || r == '\u2028' || r == '\u2029' || r == '\u202f' ||
		r == '\u205f' || r == '\u3000' || r == '\ufeff'
}

// AllowsAutomaticLink applies only after live Membership roles and email have
// been revalidated under locks. Existing bindings do not use email policy.
func (p Provider) AllowsAutomaticLink(identity VerifiedIdentity, role domain.OrganizationRole) bool {
	if !identity.EmailVerified || role != domain.OrganizationRoleMember && role != domain.OrganizationRoleAdmin ||
		role == domain.OrganizationRoleAdmin && !p.Authoritative {
		return false
	}
	email, err := domain.NormalizeEmail(identity.Email)
	if err != nil {
		return false
	}
	switch p.LinkPolicy {
	case LinkPolicyVerifiedEmail:
		return true
	case LinkPolicyVerifiedEmailInDomains:
		_, emailDomain, ok := strings.Cut(email, "@")
		if !ok {
			return false
		}
		for _, allowed := range p.LinkDomains {
			if emailDomain == allowed {
				return true
			}
		}
	}
	return false
}

func ValidSubject(subject string) bool {
	return subject != "" && utf8.ValidString(subject) && utf8.RuneCountInString(subject) <= 255 &&
		!strings.ContainsRune(subject, 0)
}
