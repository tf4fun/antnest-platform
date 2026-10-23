// Package acpincarnation records private ACP process identities and positive
// platform stop facts. It does not recover Runs or grant Agent lease ownership.
package acpincarnation

import (
	"context"
	"errors"
	"time"
)

var (
	ErrContainerNotFound = errors.New("registered container is absent")
	ErrConflict          = errors.New("incarnation registration conflict")
)

type RegisterRequest struct {
	MemberID          string `json:"member_id"`
	IncarnationID     string `json:"incarnation_id"`
	RegistrationNonce string `json:"registration_nonce"`
}

type Registration struct {
	RegistrationID string `json:"registration_id"`
	MemberID       string `json:"member_id"`
	IncarnationID  string `json:"incarnation_id"`
}

type ProbeRequest struct {
	MemberID          string `json:"member_id"`
	IncarnationID     string `json:"incarnation_id"`
	RegistrationNonce string `json:"registration_nonce"`
	Challenge         string `json:"challenge"`
}

type StopReceipt struct {
	ReceiptID  string    `json:"receipt_id"`
	Reason     string    `json:"reason"`
	ObservedAt time.Time `json:"observed_at"`
}

// Inspection has three closed wire shapes, defined by the shared schema.
// A stopped result must be retained with its complete outer identity binding.
type Inspection struct {
	State          string       `json:"state"`
	RegistrationID string       `json:"registration_id"`
	MemberID       string       `json:"member_id,omitempty"`
	IncarnationID  string       `json:"incarnation_id,omitempty"`
	Reason         string       `json:"reason,omitempty"`
	ObservedAt     *time.Time   `json:"observed_at,omitempty"`
	StopReceipt    *StopReceipt `json:"stop_receipt,omitempty"`
}

// Member is operator configuration. It must never be decoded from a caller's
// registration or inspection request.
type Member struct {
	ID       string
	Selector string
	Network  string
	Origin   string
}

type Binding struct {
	EngineID    string
	ContainerID string
	StartedAt   string
}

type Observation struct {
	ContainerID string
	StartedAt   string
	Address     string
	Running     bool
}

// Record is private persistence, not an HTTP DTO. NonceDigest is SHA-256 over
// the exact canonical hexadecimal nonce string; the nonce itself is not stored.
type Record struct {
	Scope        string
	Registration Registration
	NonceDigest  [32]byte
	Binding      Binding
	Stop         *StopReceipt
}

// Store methods return only after their actual operation and cleanup finish.
// RegisterVerified never replaces a tuple's original platform binding. An
// uncertain commit is an error; clients reconcile by the original tuple.
// RecordStopped revalidates the full binding and returns the first persisted
// receipt, including when a concurrent writer has already stored it.
type Store interface {
	FindRegistration(context.Context, string, string, string) (*Record, error)
	GetRegistration(context.Context, string, string) (*Record, error)
	RegisterVerified(context.Context, Record) (Record, error)
	RecordStopped(context.Context, string, string, Binding, StopReceipt) (Record, error)
}

type Platform interface {
	EngineID(context.Context) (string, error)
	Inspect(context.Context, string, string) (Observation, error)
}

type Prober interface {
	Probe(context.Context, Member, Observation, ProbeRequest) (ProbeRequest, error)
}

// Failure exposes only a fixed public code in logs. The underlying error is
// retained for cancellation handling, never serialized as a public message.
type Failure struct {
	Code  string
	cause error
}

func (e *Failure) Error() string { return e.Code }
func (e *Failure) Unwrap() error { return e.cause }
