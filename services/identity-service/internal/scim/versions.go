package scim

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// IfMatchCondition retains client versions as opaque text. A nil condition is
// an absent header; a non-nil empty condition matches no resource version.
type IfMatchCondition struct {
	Any  bool
	Tags []string
}

func ResourceVersion(updatedAt time.Time) string {
	return `W/"` + strconv.FormatInt(updatedAt.UnixNano(), 10) + `"`
}

func (condition *IfMatchCondition) Matches(updatedAt time.Time) bool {
	if condition == nil || condition.Any {
		return true
	}
	version := strconv.FormatInt(updatedAt.UnixNano(), 10)
	for _, tag := range condition.Tags {
		if tag == version {
			return true
		}
	}
	return false
}

var errInvalidIfMatch = errors.New("If-Match must contain a bounded entity-tag list or a standalone wildcard")

// ParseIfMatch combines repeated HTTP fields before parsing the SCIM weak
// version profile. It never interprets opaque tag text as a numeric timestamp.
func ParseIfMatch(values []string) (*IfMatchCondition, error) {
	if len(values) == 0 {
		return nil, nil
	}
	const maxBytes, maxTags, maxEmpty = 8192, 64, 64
	size := len(values) - 1
	for _, value := range values {
		if size > maxBytes || len(value) > maxBytes-size {
			return nil, errInvalidIfMatch
		}
		size += len(value)
	}
	value := strings.Join(values, ",")
	if strings.Trim(value, " \t") == "*" {
		return &IfMatchCondition{Any: true}, nil
	}
	condition := &IfMatchCondition{}
	empty := 0
	for index := 0; ; {
		for index < len(value) && (value[index] == ' ' || value[index] == '\t') {
			index++
		}
		if index == len(value) || value[index] == ',' {
			empty++
			if empty > maxEmpty {
				return nil, errInvalidIfMatch
			}
		} else {
			if strings.HasPrefix(value[index:], "W/") {
				index += 2
			}
			if index == len(value) || value[index] != '"' {
				return nil, errInvalidIfMatch
			}
			index++
			start := index
			for index < len(value) && value[index] != '"' {
				// etagc: %x21 / %x23-7E / obs-text. Backslashes do not
				// escape quotes, and a quoted comma is part of the tag.
				if value[index] < 0x21 || value[index] == 0x7f {
					return nil, errInvalidIfMatch
				}
				index++
			}
			if index == len(value) || len(condition.Tags) == maxTags {
				return nil, errInvalidIfMatch
			}
			condition.Tags = append(condition.Tags, value[start:index])
			index++
			for index < len(value) && (value[index] == ' ' || value[index] == '\t') {
				index++
			}
		}
		if index == len(value) {
			return condition, nil
		}
		if value[index] != ',' {
			return nil, errInvalidIfMatch
		}
		index++
	}
}

func ifMatchFromRequest(response http.ResponseWriter, request *http.Request) (*IfMatchCondition, bool) {
	condition, err := ParseIfMatch(request.Header.Values("If-Match"))
	if err != nil {
		writeSCIMError(response, http.StatusBadRequest, "invalidSyntax", errInvalidIfMatch.Error())
		return nil, false
	}
	return condition, true
}
