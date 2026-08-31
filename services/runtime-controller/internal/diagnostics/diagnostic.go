package diagnostics

import (
	"errors"
	"regexp"
)

var (
	urlCredentialPattern = regexp.MustCompile(`([A-Za-z][A-Za-z0-9+.-]*://[^:/@\s]+:)[^@\s]+@`)
	authorizationPattern = regexp.MustCompile(`(?i)(authorization["']?\s*[=:]\s*["']?)(?:(?:basic|bearer)\s+)?[^\s,;&"']+`)
	secretValuePattern   = regexp.MustCompile(`(?i)((?:password|passwd|token|secret|api[_-]?key)["']?\s*[=:]\s*["']?)[^\s,;&"']+`)
	bearerValuePattern   = regexp.MustCompile(`(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+`)
)

func Message(err error) string {
	if err == nil {
		return ""
	}
	value := urlCredentialPattern.ReplaceAllString(err.Error(), `${1}REDACTED@`)
	value = authorizationPattern.ReplaceAllString(value, `${1}REDACTED`)
	value = secretValuePattern.ReplaceAllString(value, `${1}REDACTED`)
	return bearerValuePattern.ReplaceAllString(value, `${1}REDACTED`)
}

func Error(err error) error {
	if err == nil {
		return nil
	}
	return errors.New(Message(err))
}
