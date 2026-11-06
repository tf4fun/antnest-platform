package registry

import (
	"encoding/json"
	"net/http"
	"net/url"
	"regexp"
	"strconv"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/skill-registry/internal/apierror"
)

var (
	registryStrongQuotedTag = regexp.MustCompile(`^"[^"\\\x00-\x20\x7f]{1,128}"$`)
	positiveDecimal         = regexp.MustCompile(`^[1-9][0-9]{0,18}$`)
)

func normalizeExpectedVersion(raw []byte, request *http.Request) ([]byte, error) {
	var fields map[string]json.RawMessage
	if err := serviceauth.DecodeObject(raw, &fields); err != nil {
		return nil, err
	}
	forms := 0
	if value, present := fields["expected_version"]; present {
		if len(value) > 0 && value[0] != '"' {
			var number json.Number
			if err := json.Unmarshal(value, &number); err != nil {
				return nil, failure(apierror.InvalidRequest, "invalid expected_version")
			}
			if parsed, err := strconv.ParseInt(number.String(), 10, 64); err != nil || parsed < 1 {
				return nil, failure(apierror.InvalidRequest, "invalid expected_version")
			}
		} else {
			var token string
			if err := json.Unmarshal(value, &token); err != nil || !positiveDecimal.MatchString(token) {
				return nil, failure(apierror.InvalidRequest, "invalid expected_version")
			}
			fields["expected_version"] = json.RawMessage(token)
		}
		forms++
	}
	headers := request.Header.Values("If-Match")
	if len(headers) > 1 {
		return nil, failure(apierror.InvalidRequest, "exactly one If-Match precondition is required")
	}
	if len(headers) == 1 {
		if !registryStrongQuotedTag.MatchString(headers[0]) || len(headers[0])-2 > 128 {
			return nil, failure(apierror.InvalidRequest, "If-Match must be one strong quoted resource tag")
		}
		token := headers[0][1 : len(headers[0])-1]
		if !positiveDecimal.MatchString(token) {
			return nil, failure(apierror.InvalidRequest, "invalid expected_version")
		}
		fields["expected_version"] = json.RawMessage(token)
		forms++
	}
	if forms > 1 {
		return nil, failure(apierror.InvalidRequest, "send only one precondition form")
	}
	if forms == 0 {
		return raw, nil
	}
	return json.Marshal(fields)
}

func strictPageQuery(r *http.Request, legacyKey string) (url.Values, error) {
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return nil, failure(apierror.InvalidRequest, "invalid query")
	}
	for key, list := range values {
		switch key {
		case "organization_id", "cursor", legacyKey, "limit":
		default:
			return nil, failure(apierror.InvalidRequest, "unknown query field")
		}
		if len(list) != 1 || list[0] == "" {
			return nil, failure(apierror.InvalidRequest, "duplicate or empty query field")
		}
	}
	if values.Has("cursor") && values.Has(legacyKey) {
		return nil, failure(apierror.InvalidRequest, "send only one cursor form")
	}
	return values, nil
}
