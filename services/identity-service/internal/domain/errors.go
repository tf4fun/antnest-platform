package domain

import "errors"

type Error struct {
	Code      string
	Message   string
	Retryable bool
}

func (e *Error) Error() string { return e.Message }

func (e *Error) Is(target error) bool {
	other, ok := target.(*Error)
	return ok && e.Code == other.Code
}

func NewError(code, message string, retryable bool) *Error {
	return &Error{Code: code, Message: message, Retryable: retryable}
}

func InvalidArgument(message string) *Error {
	return NewError(ErrInvalidArgument.Code, message, false)
}

func ErrorDetails(err error) (string, string, bool) {
	var domainError *Error
	if errors.As(err, &domainError) {
		return domainError.Code, domainError.Message, domainError.Retryable
	}
	return "internal_error", "Identity Service could not complete the request", true
}

var (
	ErrUnauthenticated       = NewError("unauthenticated", "Authentication failed", false)
	ErrForbidden             = NewError("forbidden", "The principal is not allowed to perform this operation", false)
	ErrNotFound              = NewError("not_found", "The requested identity resource does not exist", false)
	ErrConflict              = NewError("conflict", "The identity resource conflicts with an existing resource", false)
	ErrLastOrganizationAdmin = NewError(
		"last_organization_admin",
		"An organization must retain at least one active administrator",
		false,
	)
	ErrVersionConflict  = NewError("version_conflict", "The identity resource changed concurrently", true)
	ErrInvalidReference = NewError(
		"invalid_reference",
		"The referenced identity resource is invalid",
		false,
	)
	ErrInactive        = NewError("inactive_principal", "The principal is inactive", false)
	ErrInvalidArgument = NewError("invalid_argument", "The request contains an invalid argument", false)
)
