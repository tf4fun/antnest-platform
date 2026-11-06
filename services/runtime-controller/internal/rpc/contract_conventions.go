package rpc

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

var runtimeStrongQuotedTag = regexp.MustCompile(`^"[^"\\\x00-\x20\x7f]{1,128}"$`)

func normalizeRuntimePrecondition(raw []byte, request *http.Request, target any) ([]byte, error) {
	switch target.(type) {
	case *revisionRequest, *revisionConfigurationRequest:
	default:
		return raw, nil
	}
	var fields map[string]json.RawMessage
	if err := serviceauth.DecodeObject(raw, &fields); err != nil {
		return nil, err
	}
	var token string
	forms := 0
	for _, name := range []string{"expected_version", "expected_revision"} {
		value, present := fields[name]
		if !present {
			continue
		}
		var text string
		if err := json.Unmarshal(value, &text); err != nil || len(text) == 0 || len(text) > 128 {
			return nil, fmt.Errorf("precondition must be a nonempty string")
		}
		token = text
		forms++
		delete(fields, name)
	}
	headers := request.Header.Values("If-Match")
	if len(headers) > 1 {
		return nil, fmt.Errorf("exactly one If-Match precondition is required")
	}
	if len(headers) == 1 {
		if !runtimeStrongQuotedTag.MatchString(headers[0]) {
			return nil, fmt.Errorf("If-Match must be one strong quoted resource tag")
		}
		token = headers[0][1 : len(headers[0])-1]
		forms++
	}
	if forms != 1 {
		return nil, fmt.Errorf("exactly one precondition form is required")
	}
	if err := deployment.ValidateRevision(deployment.RuntimeRevision(token)); err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(token)
	if err != nil {
		return nil, err
	}
	fields["expected_revision"] = encoded
	return json.Marshal(fields)
}
