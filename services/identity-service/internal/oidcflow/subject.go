package oidcflow

import (
	"encoding/json"
	"fmt"
	"strconv"
	"unicode/utf8"
)

// ParseSubjectJSON rejects encodings that encoding/json would silently repair
// with U+FFFD. Legitimate U+FFFD and paired supplementary code points stay valid.
func ParseSubjectJSON(raw []byte) (string, error) {
	var value string
	if !utf8.Valid(raw) || json.Unmarshal(raw, &value) != nil || !ValidSubject(value) {
		return "", fmt.Errorf("invalid external identity subject")
	}
	for i := 0; i < len(raw); i++ {
		if raw[i] != '\\' {
			continue
		}
		i++
		if raw[i] != 'u' {
			continue
		}
		code, err := strconv.ParseUint(string(raw[i+1:i+5]), 16, 16)
		if err != nil {
			return "", fmt.Errorf("invalid subject escape")
		}
		i += 4
		if code >= 0xdc00 && code <= 0xdfff {
			return "", fmt.Errorf("unpaired subject surrogate")
		}
		if code < 0xd800 || code > 0xdbff {
			continue
		}
		if i+6 >= len(raw) || raw[i+1] != '\\' || raw[i+2] != 'u' {
			return "", fmt.Errorf("unpaired subject surrogate")
		}
		low, err := strconv.ParseUint(string(raw[i+3:i+7]), 16, 16)
		if err != nil || low < 0xdc00 || low > 0xdfff {
			return "", fmt.Errorf("unpaired subject surrogate")
		}
		i += 6
	}
	return value, nil
}
