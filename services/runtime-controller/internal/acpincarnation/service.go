package acpincarnation

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const operationTimeout = 10 * time.Second
const probeTimeout = 2 * time.Second

var (
	memberPattern    = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`)
	uuidPattern      = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	noncePattern     = regexp.MustCompile(`^[0-9a-f]{64}$`)
	containerPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

type Service struct {
	scope    string
	members  map[string]Member
	store    Store
	platform Platform
	prober   Prober
}

func New(scope string, members []Member, store Store, platform Platform, prober Prober) (*Service, error) {
	if scope == "" || len(scope) > 200 || strings.TrimSpace(scope) != scope || store == nil || platform == nil || prober == nil {
		return nil, fmt.Errorf("invalid ACP incarnation service dependencies")
	}
	catalog := make(map[string]Member, len(members))
	for _, member := range members {
		origin, err := url.Parse(member.Origin)
		if !validMember(member.ID) || !validPrivateLabel(member.Selector) || !validPrivateLabel(member.Network) ||
			err != nil || origin.Host == "" || origin.User != nil || origin.Opaque != "" ||
			(origin.Scheme != "http" && origin.Scheme != "https") ||
			(origin.Path != "" && origin.Path != "/") || origin.RawQuery != "" || origin.ForceQuery || origin.Fragment != "" {
			return nil, fmt.Errorf("invalid configured ACP member")
		}
		if _, exists := catalog[member.ID]; exists {
			return nil, fmt.Errorf("duplicate configured ACP member")
		}
		catalog[member.ID] = member
	}
	return &Service{scope: scope, members: catalog, store: store, platform: platform, prober: prober}, nil
}

func (s *Service) Register(parent context.Context, request RegisterRequest) (Registration, error) {
	ctx, cancel := context.WithTimeout(parent, operationTimeout)
	defer cancel()
	if !validMember(request.MemberID) || !validUUID(request.IncarnationID) || !validNonce(request.RegistrationNonce) {
		return Registration{}, failure(ctx, "invalid_request", nil)
	}
	if err := ctx.Err(); err != nil {
		return Registration{}, failure(ctx, "deadline_exceeded", err)
	}
	digest := sha256.Sum256([]byte(request.RegistrationNonce))
	existing, err := s.store.FindRegistration(ctx, s.scope, request.MemberID, request.IncarnationID)
	if err != nil || ctx.Err() != nil {
		return Registration{}, failure(ctx, "acp_registry_unavailable", err)
	}
	if existing != nil {
		if !s.validRecord(*existing) || existing.Registration.MemberID != request.MemberID || existing.Registration.IncarnationID != request.IncarnationID {
			return Registration{}, failure(ctx, "acp_registry_unavailable", nil)
		}
		if subtle.ConstantTimeCompare(existing.NonceDigest[:], digest[:]) != 1 {
			return Registration{}, failure(ctx, "acp_incarnation_conflict", nil)
		}
		return existing.Registration, nil
	}
	member, exists := s.members[request.MemberID]
	if !exists {
		return Registration{}, failure(ctx, "acp_member_not_allowed", nil)
	}
	engine, err := s.platform.EngineID(ctx)
	if err != nil || ctx.Err() != nil || !validPrivateLabel(engine) {
		return Registration{}, failure(ctx, "acp_registration_unavailable", err)
	}
	observed, err := s.platform.Inspect(ctx, member.Selector, member.Network)
	if err != nil || ctx.Err() != nil || !validObservation(observed) || !observed.Running || !validAddress(observed.Address) {
		return Registration{}, failure(ctx, "acp_registration_unavailable", err)
	}
	challenge, err := randomHex(32)
	if err != nil {
		return Registration{}, failure(ctx, "internal_error", err)
	}
	probe := ProbeRequest{MemberID: request.MemberID, IncarnationID: request.IncarnationID, RegistrationNonce: request.RegistrationNonce, Challenge: challenge}
	probeContext, stopProbe := context.WithTimeout(ctx, probeTimeout)
	reply, err := s.prober.Probe(probeContext, member, observed, probe)
	probeErr := probeContext.Err()
	stopProbe()
	// Probe is synchronous: a cancellation receipt cannot substitute for the
	// original HTTP call, body read and cleanup actually finishing.
	if err != nil || probeErr != nil || ctx.Err() != nil {
		return Registration{}, failure(ctx, "acp_registration_unavailable", errors.Join(err, probeErr))
	}
	if reply.MemberID != probe.MemberID || reply.IncarnationID != probe.IncarnationID ||
		subtle.ConstantTimeCompare([]byte(reply.RegistrationNonce), []byte(probe.RegistrationNonce)) != 1 ||
		subtle.ConstantTimeCompare([]byte(reply.Challenge), []byte(probe.Challenge)) != 1 {
		return Registration{}, failure(ctx, "acp_incarnation_unverified", nil)
	}
	confirmed, err := s.platform.Inspect(ctx, observed.ContainerID, member.Network)
	if err != nil || ctx.Err() != nil || confirmed.ContainerID != observed.ContainerID ||
		confirmed.Address != observed.Address || confirmed.Running != observed.Running || !sameStart(confirmed.StartedAt, observed.StartedAt) {
		return Registration{}, failure(ctx, "acp_registration_unavailable", err)
	}
	confirmedEngine, err := s.platform.EngineID(ctx)
	if err != nil || confirmedEngine != engine || ctx.Err() != nil {
		return Registration{}, failure(ctx, "acp_registration_unavailable", err)
	}
	id, err := randomUUID()
	if err != nil || ctx.Err() != nil {
		return Registration{}, failure(ctx, "internal_error", err)
	}
	started, _ := time.Parse(time.RFC3339Nano, observed.StartedAt)
	candidate := Record{
		Scope: s.scope, Registration: Registration{RegistrationID: id, MemberID: request.MemberID, IncarnationID: request.IncarnationID},
		NonceDigest: digest, Binding: Binding{EngineID: engine, ContainerID: observed.ContainerID, StartedAt: started.UTC().Format(time.RFC3339Nano)},
	}
	winner, err := s.store.RegisterVerified(ctx, candidate)
	if errors.Is(err, ErrConflict) {
		return Registration{}, failure(ctx, "acp_incarnation_conflict", err)
	}
	if err != nil || ctx.Err() != nil || !s.validRecord(winner) || winner.Registration.MemberID != request.MemberID ||
		winner.Registration.IncarnationID != request.IncarnationID || winner.Binding != candidate.Binding ||
		subtle.ConstantTimeCompare(winner.NonceDigest[:], digest[:]) != 1 {
		return Registration{}, failure(ctx, "acp_registry_unavailable", err)
	}
	return winner.Registration, nil
}

func (s *Service) Inspect(parent context.Context, registrationID string) (Inspection, error) {
	ctx, cancel := context.WithTimeout(parent, operationTimeout)
	defer cancel()
	if !validUUID(registrationID) {
		return Inspection{}, failure(ctx, "invalid_request", nil)
	}
	if err := ctx.Err(); err != nil {
		return Inspection{}, failure(ctx, "deadline_exceeded", err)
	}
	record, err := s.store.GetRegistration(ctx, s.scope, registrationID)
	if err != nil || ctx.Err() != nil {
		return Inspection{}, failure(ctx, "acp_registry_unavailable", err)
	}
	if record == nil {
		return unknown(registrationID, "unregistered"), nil
	}
	if !s.validRecord(*record) || record.Registration.RegistrationID != registrationID {
		return Inspection{}, failure(ctx, "acp_registry_unavailable", nil)
	}
	if record.Stop != nil {
		return stopped(*record), nil
	}
	member, exists := s.members[record.Registration.MemberID]
	if !exists {
		return unknown(registrationID, "membership_unavailable"), nil
	}
	engine, err := s.platform.EngineID(ctx)
	if err != nil || ctx.Err() != nil || !validPrivateLabel(engine) {
		return observationUnavailable(ctx, registrationID, err)
	}
	if engine != record.Binding.EngineID {
		return unknown(registrationID, "engine_changed"), nil
	}
	observed, inspectErr := s.platform.Inspect(ctx, record.Binding.ContainerID, member.Network)
	if ctx.Err() != nil {
		return Inspection{}, failure(ctx, "deadline_exceeded", inspectErr)
	}
	if inspectErr != nil && !errors.Is(inspectErr, ErrContainerNotFound) {
		return observationUnavailable(ctx, registrationID, inspectErr)
	}
	// Recheck the engine even for 404: querying a replacement engine must not
	// manufacture positive absence of a container registered on the old one.
	confirmedEngine, err := s.platform.EngineID(ctx)
	if err != nil || ctx.Err() != nil || !validPrivateLabel(confirmedEngine) {
		return observationUnavailable(ctx, registrationID, err)
	}
	if confirmedEngine != engine {
		return unknown(registrationID, "engine_changed"), nil
	}
	if err := ctx.Err(); err != nil {
		return Inspection{}, failure(ctx, "deadline_exceeded", err)
	}
	reason := ""
	if errors.Is(inspectErr, ErrContainerNotFound) {
		reason = "container_removed"
	} else if !validObservation(observed) || observed.ContainerID != record.Binding.ContainerID {
		return unknown(registrationID, "platform_unavailable"), nil
	} else if !sameStart(observed.StartedAt, record.Binding.StartedAt) {
		reason = "container_restarted"
	} else if !observed.Running {
		reason = "container_stopped"
	}
	if reason == "" {
		now := time.Now().UTC()
		return Inspection{State: "running", RegistrationID: registrationID, MemberID: record.Registration.MemberID, IncarnationID: record.Registration.IncarnationID, ObservedAt: &now}, nil
	}
	id, err := randomUUID()
	if err != nil || ctx.Err() != nil {
		return Inspection{}, failure(ctx, "internal_error", err)
	}
	receipt := StopReceipt{ReceiptID: id, Reason: reason, ObservedAt: time.Now().UTC()}
	winner, err := s.store.RecordStopped(ctx, s.scope, registrationID, record.Binding, receipt)
	if err != nil || ctx.Err() != nil || !s.validRecord(winner) || winner.Registration != record.Registration || winner.Binding != record.Binding || winner.Stop == nil {
		return Inspection{}, failure(ctx, "acp_registry_unavailable", err)
	}
	return stopped(winner), nil
}

func (s *Service) validRecord(record Record) bool {
	if record.Scope != s.scope || !validUUID(record.Registration.RegistrationID) ||
		!validMember(record.Registration.MemberID) || !validUUID(record.Registration.IncarnationID) ||
		!validPrivateLabel(record.Binding.EngineID) || !validObservation(Observation{ContainerID: record.Binding.ContainerID, StartedAt: record.Binding.StartedAt}) {
		return false
	}
	if receipt := record.Stop; receipt != nil {
		if !validUUID(receipt.ReceiptID) || receipt.ObservedAt.IsZero() {
			return false
		}
		switch receipt.Reason {
		case "container_stopped", "container_restarted", "container_removed":
		default:
			return false
		}
	}
	return true
}

func stopped(record Record) Inspection {
	receipt := *record.Stop
	receipt.ObservedAt = receipt.ObservedAt.UTC()
	return Inspection{State: "stopped", RegistrationID: record.Registration.RegistrationID, MemberID: record.Registration.MemberID, IncarnationID: record.Registration.IncarnationID, StopReceipt: &receipt}
}

func unknown(id, reason string) Inspection {
	return Inspection{State: "unknown", RegistrationID: id, Reason: reason}
}

func observationUnavailable(ctx context.Context, id string, err error) (Inspection, error) {
	if ctx.Err() != nil {
		return Inspection{}, failure(ctx, "deadline_exceeded", err)
	}
	return unknown(id, "platform_unavailable"), nil
}

func failure(ctx context.Context, code string, err error) *Failure {
	if ctx.Err() != nil {
		return &Failure{Code: "deadline_exceeded", cause: errors.Join(err, ctx.Err())}
	}
	return &Failure{Code: code, cause: err}
}

func validMember(value string) bool {
	return len(value) >= 1 && len(value) <= 64 && memberPattern.MatchString(value)
}
func validUUID(value string) bool  { return len(value) == 36 && uuidPattern.MatchString(value) }
func validNonce(value string) bool { return len(value) == 64 && noncePattern.MatchString(value) }
func validPrivateLabel(value string) bool {
	return value != "" && len(value) <= 256 && strings.IndexFunc(value, func(r rune) bool { return r <= ' ' || r == 127 }) == -1
}
func validObservation(value Observation) bool {
	started, err := time.Parse(time.RFC3339Nano, value.StartedAt)
	return len(value.ContainerID) == 64 && containerPattern.MatchString(value.ContainerID) && err == nil && !started.IsZero()
}
func sameStart(left, right string) bool {
	first, firstErr := time.Parse(time.RFC3339Nano, left)
	second, secondErr := time.Parse(time.RFC3339Nano, right)
	return firstErr == nil && secondErr == nil && first.Equal(second)
}
func validAddress(value string) bool {
	address, err := netip.ParseAddr(value)
	return err == nil && address.Zone() == "" && !address.IsUnspecified() && !address.IsMulticast()
}

func randomHex(bytes int) (string, error) {
	value := make([]byte, bytes)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}

func randomUUID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	value[6] = value[6]&0x0f | 0x40
	value[8] = value[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", value[:4], value[4:6], value[6:8], value[8:10], value[10:]), nil
}
