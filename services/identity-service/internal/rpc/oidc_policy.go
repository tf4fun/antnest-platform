package rpc

import (
	"bytes"
	"encoding/json"
	"net/http"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/oidcflow"
)

func decodeProviderPolicy(response http.ResponseWriter, body upsertOIDCProviderRequest, input *oidcflow.UpsertProviderInput) bool {
	if len(body.LinkPolicy) == 0 && len(body.LinkDomains) == 0 && len(body.Authoritative) == 0 && len(body.AcknowledgeLinkPolicyReview) == 0 {
		return true
	}
	reject := func() bool {
		writeError(response, domain.NewError("bad_request", "A complete non-null linking policy is required", false))
		return false
	}
	if len(body.LinkPolicy) == 0 || len(body.LinkDomains) == 0 || len(body.Authoritative) == 0 {
		return reject()
	}
	for _, raw := range []json.RawMessage{body.LinkPolicy, body.LinkDomains, body.Authoritative, body.AcknowledgeLinkPolicyReview} {
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return reject()
		}
	}
	if json.Unmarshal(body.LinkPolicy, &input.LinkPolicy) != nil || json.Unmarshal(body.LinkDomains, &input.LinkDomains) != nil || json.Unmarshal(body.Authoritative, &input.Authoritative) != nil {
		return reject()
	}
	// encoding/json would decode a null array element into the empty string.
	var domains []json.RawMessage
	if json.Unmarshal(body.LinkDomains, &domains) != nil {
		return reject()
	}
	for _, raw := range domains {
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return reject()
		}
	}
	if len(body.AcknowledgeLinkPolicyReview) != 0 && json.Unmarshal(body.AcknowledgeLinkPolicyReview, &input.AcknowledgeLinkPolicyReview) != nil {
		return reject()
	}
	return true
}
