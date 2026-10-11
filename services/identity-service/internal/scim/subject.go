package scim

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/oidcflow"
)

// SCIM attribute names remain case-insensitive and extension attributes stay
// permitted. A dynamic map retains raw values while rejecting duplicate keys,
// including aliases which encoding/json would otherwise silently overwrite.
func scimObject(raw []byte) (map[string]json.RawMessage, error) {
	var original map[string]json.RawMessage
	if err := serviceauth.DecodeObject(raw, &original); err != nil {
		return nil, err
	}
	fields := make(map[string]json.RawMessage, len(original))
	for key, value := range original {
		name := strings.Map(func(r rune) rune {
			// Match encoding/json's Unicode case folding too (for example
			// operationſ), so aliases cannot bypass duplicate detection.
			minimum := r
			for next := unicode.SimpleFold(r); next != r; next = unicode.SimpleFold(next) {
				if next < minimum {
					minimum = next
				}
			}
			// Only ASCII lowering is safe here: Unicode ToLower would merge
			// distinct SimpleFold classes such as I/i and the dotted capital İ.
			if minimum >= 'A' && minimum <= 'Z' {
				return minimum + ('a' - 'A')
			}
			return minimum
		}, key)
		if _, exists := fields[name]; exists {
			return nil, fmt.Errorf("duplicate SCIM attribute")
		}
		fields[name] = value
	}
	return fields, nil
}

func (input UserInput) externalID(paired bool) (string, error) {
	if !paired {
		return strings.TrimSpace(input.ExternalID), nil
	}
	value := input.ExternalID
	if input.externalIDJSON != nil {
		var err error
		value, err = oidcflow.ParseSubjectJSON(input.externalIDJSON)
		if err != nil {
			return "", domain.InvalidArgument("paired externalId must be a valid nonempty opaque subject")
		}
	}
	if !oidcflow.ValidSubject(value) {
		return "", domain.InvalidArgument("paired externalId must be a valid nonempty opaque subject")
	}
	return value, nil
}

func (input UserInput) replacementExternalID(current domain.OrganizationMembership) (string, error) {
	if current.SCIMOIDCProviderID == nil {
		return input.externalID(false)
	}
	if input.externalIDJSON == nil && input.ExternalID == "" {
		return current.SCIMExternalID, nil
	}
	value, err := input.externalID(true)
	if err != nil {
		return "", err
	}
	if value != current.SCIMExternalID {
		return "", domain.InvalidArgument("paired externalId cannot be changed or cleared")
	}
	return value, nil
}
