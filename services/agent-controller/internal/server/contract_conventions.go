package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strconv"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
)

var (
	strongQuotedTag     = regexp.MustCompile(`^"[^"\\\x00-\x20\x7f]{1,128}"$`)
	unsignedDecimalText = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)
)

func normalizePrecondition(raw []byte, request *http.Request, target any) ([]byte, error) {
	var field string
	var opaque, unsigned, numericExpectedVersion bool
	switch target.(type) {
	case *reviseModelProfileRequest:
		field, numericExpectedVersion = "expected_version", true
	case *rotateProviderCredentialRequest:
		field, opaque = "expected_version", true
	case *application.SetModelCallPolicyInput, *application.SetRuntimeBarrierRecoveryPolicyInput:
		field = "expected_revision"
	case *application.SetSkillLearningPolicyInput:
		field, opaque = "expected_revision", true
	case *application.SetAgentNetworkPolicyInput:
		field, unsigned = "expected_resource_version", true
	default:
		return raw, nil
	}

	var fields map[string]json.RawMessage
	if err := serviceauth.DecodeObject(raw, &fields); err != nil {
		return nil, err
	}
	var candidates []string
	names := []string{"expected_version"}
	if field != "expected_version" {
		names = append(names, field)
	}
	for _, name := range names {
		if _, present := fields[name]; present {
			candidates = append(candidates, name)
		}
	}
	headers := request.Header.Values("If-Match")
	if len(headers) > 1 {
		return nil, fmt.Errorf("exactly one If-Match precondition is required")
	}
	header := ""
	if len(headers) == 1 {
		if !strongQuotedTag.MatchString(headers[0]) || len(headers[0])-2 > 128 {
			return nil, fmt.Errorf("If-Match must be one strong quoted resource tag")
		}
		header = headers[0][1 : len(headers[0])-1]
	}
	switch {
	case len(candidates) > 1:
		return nil, fmt.Errorf("send only one precondition form")
	case len(candidates) == 1 && header != "":
		return nil, fmt.Errorf("send the precondition either in the body or If-Match, not both")
	case len(candidates) == 0 && header == "":
		return nil, fmt.Errorf("a precondition is required")
	}

	var token string
	fromHeader := header != ""
	if fromHeader {
		token = header
	} else {
		name := candidates[0]
		value := bytes.TrimSpace(fields[name])
		if bytes.Equal(value, []byte("null")) {
			return nil, fmt.Errorf("%s must not be null", name)
		}
		if name == "expected_version" && !numericExpectedVersion && value[0] != '"' {
			return nil, fmt.Errorf("expected_version must be a string")
		}
		if name == field && field != "expected_version" {
			if opaque && value[0] != '"' {
				return nil, fmt.Errorf("%s must be a string", name)
			}
			if !opaque && value[0] == '"' {
				return nil, fmt.Errorf("%s must be a number", name)
			}
		}
		if value[0] == '"' {
			var decoded string
			if err := json.Unmarshal(value, &decoded); err != nil {
				return nil, fmt.Errorf("%s must be a string", name)
			}
			token = decoded
		} else {
			fields[field] = value
			if name != field {
				delete(fields, name)
			}
			return marshalNormalized(fields)
		}
	}

	if opaque {
		if token == "" || len(token) > 128 {
			return nil, fmt.Errorf("precondition token must be 1..128 bytes")
		}
		encoded, err := json.Marshal(token)
		if err != nil {
			return nil, err
		}
		fields[field] = encoded
	} else {
		if !unsignedDecimalText.MatchString(token) || len(token) > 20 {
			return nil, fmt.Errorf("precondition must be an unsigned decimal string")
		}
		if unsigned {
			parsed, err := strconv.ParseUint(token, 10, 64)
			if err != nil {
				return nil, fmt.Errorf("precondition overflows uint64")
			}
			fields[field] = json.RawMessage(strconv.FormatUint(parsed, 10))
		} else {
			parsed, err := strconv.ParseInt(token, 10, 64)
			if err != nil {
				return nil, fmt.Errorf("precondition overflows int64")
			}
			fields[field] = json.RawMessage(strconv.FormatInt(parsed, 10))
		}
	}
	if !fromHeader && candidates[0] != field {
		delete(fields, candidates[0])
	}
	return marshalNormalized(fields)
}

func marshalNormalized(fields map[string]json.RawMessage) ([]byte, error) {
	normalized, err := json.Marshal(fields)
	if err != nil {
		return nil, err
	}
	return normalized, nil
}
