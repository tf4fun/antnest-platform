package identity

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"
)

// An opaque subject must survive JSON without encoding/json repairing invalid
// Unicode. Literal U+FFFD, whitespace and paired supplementary scalars are valid.
func parseExternalIdentitySubject(raw []byte) (string, error) {
	var value string
	if !utf8.Valid(raw) || json.Unmarshal(raw, &value) != nil || value == "" || utf8.RuneCountInString(value) > 255 || strings.ContainsRune(value, 0) {
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
