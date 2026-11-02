package registry

import (
	"errors"
	"fmt"
	"github.com/tf4fun/antnest-platform/services/skill-registry/internal/apierror"
)

type Error struct {
	Kind string
	Text string
}

func (e *Error) Error() string { return e.Text }

func failure(kind, format string, args ...any) error {
	return &Error{Kind: kind, Text: fmt.Sprintf(format, args...)}
}

func Code(err error) string {
	var typed *Error
	if errors.As(err, &typed) {
		return typed.Kind
	}
	return apierror.TemporarilyUnavailable
}
