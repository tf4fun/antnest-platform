package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strconv"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/apierror"
)

var consoleStrongQuotedTag = regexp.MustCompile(`^"[^"\\\x00-\x20\x7f]{1,128}"$`)

func canonicalPage(body []byte, legacyItems, legacyCursor string, numericLegacy bool) ([]byte, error) {
	var fields map[string]json.RawMessage
	if err := serviceauth.DecodeObject(body, &fields); err != nil {
		return nil, err
	}
	if legacyItems != "" && legacyItems != "items" {
		_, hasItems := fields["items"]
		legacy, hasLegacy := fields[legacyItems]
		if hasItems && hasLegacy {
			return nil, errors.New(legacyItems + " and items must not coexist")
		}
		if !hasItems && hasLegacy {
			fields["items"] = legacy
			delete(fields, legacyItems)
		}
	}
	_, hasCanonical := fields["next_cursor"]
	legacy, hasLegacy := fields[legacyCursor]
	if hasCanonical && hasLegacy {
		return nil, errors.New("next_cursor and " + legacyCursor + " must not coexist")
	}
	if hasLegacy {
		delete(fields, legacyCursor)
		trimmed := bytes.TrimSpace(legacy)
		if bytes.Equal(trimmed, []byte("null")) {
			fields["next_cursor"] = json.RawMessage("null")
		} else if trimmed[0] != '"' {
			if !numericLegacy {
				return nil, errors.New(legacyCursor + " must be a string")
			}
			var number json.Number
			decoder := json.NewDecoder(bytes.NewReader(trimmed))
			decoder.UseNumber()
			if err := decoder.Decode(&number); err != nil {
				return nil, err
			}
			parsed, err := strconv.ParseInt(number.String(), 10, 64)
			if err != nil || parsed < 0 {
				return nil, errors.New("invalid " + legacyCursor)
			}
			if parsed == 0 {
				fields["next_cursor"] = json.RawMessage("null")
			} else {
				fields["next_cursor"] = json.RawMessage(strconv.Quote(number.String()))
			}
		} else {
			var text string
			if err := json.Unmarshal(trimmed, &text); err != nil || len(text) > 4096 {
				return nil, errors.New("invalid " + legacyCursor)
			}
			if text == "" {
				if legacyItems != "items" {
					return nil, errors.New("invalid " + legacyCursor)
				}
				fields["next_cursor"] = json.RawMessage("null")
			} else {
				fields["next_cursor"] = trimmed
			}
		}
	} else if !hasCanonical {
		fields["next_cursor"] = json.RawMessage("null")
	} else if value := bytes.TrimSpace(fields["next_cursor"]); !bytes.Equal(value, []byte("null")) {
		var text string
		if err := json.Unmarshal(value, &text); err != nil || len(text) == 0 || len(text) > 4096 {
			return nil, errors.New("invalid next_cursor")
		}
	}
	return json.Marshal(fields)
}

func canonicalListCursor(response http.ResponseWriter, input url.Values, legacyName string) (string, bool) {
	hasCanonical := input.Has("cursor")
	hasLegacy := legacyName != "" && input.Has(legacyName)
	if hasCanonical && hasLegacy {
		writeError(response, http.StatusBadRequest, apierror.InvalidRequest, "send only one cursor form")
		return "", false
	}
	if (hasCanonical && input.Get("cursor") == "") || (hasLegacy && input.Get(legacyName) == "") {
		writeError(response, http.StatusBadRequest, apierror.InvalidRequest, "cursor must not be empty")
		return "", false
	}
	token := input.Get("cursor")
	if token == "" {
		token = input.Get(legacyName)
	}
	if len(token) > 4096 {
		writeError(response, http.StatusBadRequest, apierror.InvalidRequest, "cursor exceeds bound")
		return "", false
	}
	return token, true
}

func normalizeConsolePrecondition(raw []byte, request *http.Request, legacyField string, numeric bool, required bool) ([]byte, error) {
	var fields map[string]json.RawMessage
	if err := serviceauth.DecodeObject(raw, &fields); err != nil {
		return nil, err
	}
	forms := 0
	var selected string
	if value, present := fields["expected_version"]; present {
		forms++
		token, err := consolePreconditionValue(value, "expected_version", numeric, legacyField == "expected_version")
		if err != nil {
			return nil, err
		}
		selected = token
	}
	if legacyField != "expected_version" {
		if value, present := fields[legacyField]; present {
			if numeric && bytes.HasPrefix(bytes.TrimSpace(value), []byte(`"`)) {
				return nil, errors.New(legacyField + " must be a number")
			}
			forms++
			token, err := consolePreconditionValue(value, legacyField, numeric, true)
			if err != nil {
				return nil, err
			}
			selected = token
		}
	}
	headers := request.Header.Values("If-Match")
	if len(headers) > 1 {
		return nil, errors.New("exactly one If-Match is required")
	}
	if len(headers) == 1 {
		if !consoleStrongQuotedTag.MatchString(headers[0]) || len(headers[0])-2 > 128 {
			return nil, errors.New("If-Match must be one strong quoted resource tag")
		}
		token := headers[0][1 : len(headers[0])-1]
		if numeric && !validVersionToken(token) || !numeric && (len(token) < 1 || len(token) > 128) {
			return nil, errors.New("invalid If-Match precondition")
		}
		forms++
		selected = token
	}
	if forms > 1 {
		return nil, errors.New("send only one precondition form")
	}
	if required && forms == 0 {
		return nil, errors.New("precondition is required")
	}
	if forms == 0 {
		return raw, nil
	}
	if numeric {
		fields[legacyField] = json.RawMessage(selected)
	} else {
		fields[legacyField] = json.RawMessage(strconv.Quote(selected))
	}
	if legacyField != "expected_version" {
		delete(fields, "expected_version")
	}
	return json.Marshal(fields)
}

func consolePreconditionValue(value json.RawMessage, name string, numeric bool, legacySameName bool) (string, error) {
	trimmed := bytes.TrimSpace(value)
	if bytes.Equal(trimmed, []byte("null")) || len(trimmed) == 0 {
		return "", errors.New(name + " must not be null")
	}
	if trimmed[0] != '"' {
		if !numeric || !legacySameName {
			return "", errors.New(name + " must be a string")
		}
		var number json.Number
		decoder := json.NewDecoder(bytes.NewReader(trimmed))
		decoder.UseNumber()
		if err := decoder.Decode(&number); err != nil {
			return "", errors.New("invalid " + name)
		}
		if parsed, err := strconv.ParseInt(number.String(), 10, 64); err != nil || parsed < 0 {
			return "", errors.New("invalid " + name)
		}
		return number.String(), nil
	}
	var token string
	if err := json.Unmarshal(trimmed, &token); err != nil {
		return "", errors.New("invalid " + name)
	}
	if numeric {
		if !validVersionToken(token) {
			return "", errors.New("invalid " + name)
		}
	} else if len(token) < 1 || len(token) > 128 {
		return "", errors.New("invalid " + name)
	}
	return token, nil
}

func validVersionToken(token string) bool {
	if len(token) == 0 || len(token) > 20 {
		return false
	}
	for i, r := range token {
		if r < '0' || r > '9' || (i == 0 && r == '0' && len(token) > 1) {
			return false
		}
	}
	_, err := strconv.ParseInt(token, 10, 64)
	return err == nil
}
