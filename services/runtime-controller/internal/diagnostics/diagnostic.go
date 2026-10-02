package diagnostics

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/platform"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/repository"
)

func Message(err error) string {
	return strings.Join(Causes(err), "; ")
}

func Error(err error) error {
	if err == nil {
		return nil
	}
	return errors.New(Message(err))
}

// Error producers explicitly mark permanent failures. Do not infer permanence
// from arbitrary Docker, database or provider response text.
func IsPermanent(err error) bool {
	var permanent interface{ Permanent() bool }
	return errors.As(err, &permanent) && permanent.Permanent()
}

// Arbitrary error strings can contain entire Docker/SQL/provider responses.
// Preserve types and registered facts, never guess safety from regex redaction.
func Causes(err error) []string {
	var result []string
	var visit func(error)
	visit = func(current error) {
		if current == nil || len(result) == 4 {
			return
		}
		result = append(result, fmt.Sprintf("%T: %s", current, safeCause(current)))
		if joined, ok := current.(interface{ Unwrap() []error }); ok {
			for _, cause := range joined.Unwrap() {
				visit(cause)
			}
		} else {
			visit(errors.Unwrap(current))
		}
	}
	visit(err)
	return result
}

func CauseTypes(err error) []string {
	var result []string
	var visit func(error)
	visit = func(current error) {
		if current == nil || len(result) == 4 {
			return
		}
		result = append(result, fmt.Sprintf("%T", current))
		if joined, ok := current.(interface{ Unwrap() []error }); ok {
			for _, cause := range joined.Unwrap() {
				visit(cause)
			}
		} else {
			visit(errors.Unwrap(current))
		}
	}
	visit(err)
	return result
}

func safeCause(err error) string {
	if IsPermanent(err) {
		return "permanent configuration, schema or programming error"
	}
	for _, known := range []error{
		context.Canceled, context.DeadlineExceeded, io.EOF, io.ErrUnexpectedEOF,
		deployment.ErrInvalid, deployment.ErrIdentityConflict, deployment.ErrStatusUnverified,
		platform.ErrInvalidImageReference, platform.ErrImageNotFound, platform.ErrImageResolutionUnavailable,
		platform.ErrObservationStreamDisconnected,
		repository.ErrNotFound, repository.ErrLockLost, repository.ErrConcurrentMutation,
		repository.ErrRevisionConflict, repository.ErrTransitionConflict, repository.ErrInvariantConflict,
		repository.ErrIdempotencyConflict, repository.ErrOperationFinalized,
	} {
		if errors.Is(err, known) {
			return known.Error()
		}
	}
	switch value := err.(type) {
	case *json.SyntaxError:
		return fmt.Sprintf("invalid JSON at byte %d", value.Offset)
	case *json.UnmarshalTypeError:
		return fmt.Sprintf("JSON type mismatch at byte %d", value.Offset)
	case interface{ SQLState() string }:
		state := value.SQLState()
		if len(state) == 5 && strings.IndexFunc(state, func(r rune) bool { return (r < '0' || r > '9') && (r < 'A' || r > 'Z') }) == -1 {
			return "database SQLSTATE " + state
		}
	case net.Error:
		if value.Timeout() {
			return "network timeout"
		}
		return "network operation failed"
	}
	return "unregistered error message REDACTED"
}
