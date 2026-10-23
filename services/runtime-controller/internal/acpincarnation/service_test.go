package acpincarnation

import (
	"context"
	"crypto/sha256"
	"errors"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"
)

func TestRegisterReturnsOriginalMatchingReceiptBeforeCatalogOrPlatform(t *testing.T) {
	f := newIncarnationServiceFixture(t)
	f.members = nil
	original := f.record
	f.store.find = func(_ context.Context, scope, member, incarnation string) (*Record, error) {
		if scope != f.scope || member != f.request.MemberID || incarnation != f.request.IncarnationID {
			t.Error("registration lookup lost its configured scope or original identity")
		}
		return cloneIncarnationServiceRecord(&original), nil
	}
	got, err := f.service(t).Register(t.Context(), f.request)
	if err != nil {
		t.Fatal("matching registration replay failed")
	}
	requireIncarnationServiceEqual(t, got, original.Registration, "replay replaced the original registration")
	requireIncarnationServiceEqual(t, f.calls.snapshot(), []string{"find"}, "replay consulted catalog dependencies or performed a write")
	requireIncarnationServiceEqual(t, original, f.record, "replay changed the stored binding")
}

func TestRegisterRejectsOriginalTupleWithDifferentNonceWithoutEffects(t *testing.T) {
	f := newIncarnationServiceFixture(t)
	f.record.NonceDigest = sha256.Sum256([]byte(strings.Repeat("2", 64)))
	f.store.find = func(context.Context, string, string, string) (*Record, error) {
		return cloneIncarnationServiceRecord(&f.record), nil
	}
	got, err := f.service(t).Register(t.Context(), f.request)
	requireIncarnationServiceFailure(t, err, "acp_incarnation_conflict")
	requireIncarnationServiceEqual(t, got, Registration{}, "conflicting registration returned a successful receipt")
	requireIncarnationServiceEqual(t, f.calls.snapshot(), []string{"find"}, "conflicting nonce caused platform work or mutation")
}

func TestRegisterDoesNotTreatRegistryFailureAsMissingRegistration(t *testing.T) {
	f := newIncarnationServiceFixture(t)
	f.store.find = func(context.Context, string, string, string) (*Record, error) {
		return nil, errors.New("fixture registry read failed")
	}
	got, err := f.service(t).Register(t.Context(), f.request)
	requireIncarnationServiceFailure(t, err, "acp_registry_unavailable")
	requireIncarnationServiceEqual(t, got, Registration{}, "registry failure returned a registration")
	requireIncarnationServiceEqual(t, f.calls.snapshot(), []string{"find"}, "registry failure fell through to platform work")
}

func TestRegisterVerifiesOriginalIntentAndRechecksPlatformBeforePersistence(t *testing.T) {
	var previousChallenge, previousRegistration string
	for attempt := 0; attempt < 2; attempt++ {
		f := newIncarnationServiceFixture(t)
		originalRequest := f.request
		var challenge string
		var written *Record
		f.prober.probe = func(_ context.Context, member Member, observed Observation, request ProbeRequest) (ProbeRequest, error) {
			requireIncarnationServiceEqual(t, member, f.member, "probe used a requester-controlled member")
			requireIncarnationServiceEqual(t, observed, f.observation, "probe was not bound to the inspected container")
			if request.MemberID != f.request.MemberID || request.IncarnationID != f.request.IncarnationID || request.RegistrationNonce != f.request.RegistrationNonce {
				t.Error("probe lost the original registration intent")
			}
			if !incarnationServiceNonce.MatchString(request.Challenge) || request.Challenge == request.RegistrationNonce {
				t.Error("probe challenge is not a separate canonical random nonce")
			}
			challenge = request.Challenge
			return request, nil
		}
		f.store.register = func(_ context.Context, candidate Record) (Record, error) {
			calls := f.calls.snapshot()
			probe := incarnationServiceCallIndex(calls, "probe")
			if probe < 0 || !incarnationServiceHasCall(calls[:probe], "engine") || !incarnationServiceHasCall(calls[:probe], "inspect") || !incarnationServiceHasCall(calls[probe+1:], "engine") || !incarnationServiceHasCall(calls[probe+1:], "inspect") {
				t.Error("registration was persisted before platform verification and recheck")
			}
			if candidate.Scope != f.scope || candidate.Registration.MemberID != f.request.MemberID || candidate.Registration.IncarnationID != f.request.IncarnationID {
				t.Error("persisted registration has the wrong scope or original identity")
			}
			if !incarnationServiceUUID.MatchString(candidate.Registration.RegistrationID) {
				t.Error("registration identifier is not a canonical UUIDv4")
			}
			if candidate.NonceDigest != sha256.Sum256([]byte(f.request.RegistrationNonce)) {
				t.Error("repository did not receive the canonical wire nonce digest")
			}
			requireIncarnationServiceEqual(t, candidate.Binding, f.record.Binding, "registration did not persist the verified engine/container/start")
			if candidate.Stop != nil {
				t.Error("new registration fabricated a stop receipt")
			}
			written = cloneIncarnationServiceRecord(&candidate)
			return candidate, nil
		}
		got, err := f.service(t).Register(t.Context(), f.request)
		if err != nil || written == nil {
			t.Fatal("verified registration did not reach durable admission")
		}
		requireIncarnationServiceEqual(t, got, written.Registration, "registration returned a receipt different from the repository result")
		requireIncarnationServiceEqual(t, f.request, originalRequest, "registration mutated its original request")
		if incarnationServiceCallCount(f.calls.snapshot(), "probe") != 1 || incarnationServiceCallCount(f.calls.snapshot(), "register") != 1 {
			t.Error("first registration duplicated verification or persistence")
		}
		if attempt > 0 && (challenge == previousChallenge || got.RegistrationID == previousRegistration) {
			t.Error("independent registration attempts reused random control identities")
		}
		previousChallenge, previousRegistration = challenge, got.RegistrationID
	}
}

func TestRegisterRejectsEveryMismatchedProbeEcho(t *testing.T) {
	for _, field := range []string{"member", "incarnation", "registration_nonce", "challenge"} {
		t.Run(field, func(t *testing.T) {
			f := newIncarnationServiceFixture(t)
			f.prober.probe = func(_ context.Context, _ Member, _ Observation, response ProbeRequest) (ProbeRequest, error) {
				switch field {
				case "member":
					response.MemberID = "acp-other"
				case "incarnation":
					response.IncarnationID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
				case "registration_nonce":
					response.RegistrationNonce = strings.Repeat("2", 64)
				case "challenge":
					if len(response.Challenge) == 0 {
						response.Challenge = strings.Repeat("1", 64)
					} else if response.Challenge[0] == '0' {
						response.Challenge = "1" + response.Challenge[1:]
					} else {
						response.Challenge = "0" + response.Challenge[1:]
					}
				}
				return response, nil
			}
			got, err := f.service(t).Register(t.Context(), f.request)
			requireIncarnationServiceFailure(t, err, "acp_incarnation_unverified")
			requireIncarnationServiceEqual(t, got, Registration{}, "unverified probe returned a registration")
			requireIncarnationServiceNoWrites(t, f)
		})
	}
}

func TestRegisterRequiresActualSelectedNetworkAddressBeforeProbe(t *testing.T) {
	for _, address := range []string{"", "acp-member.internal", "0.0.0.0", "224.0.0.1", "fe80::1%host"} {
		f := newIncarnationServiceFixture(t)
		f.observation.Address = address
		got, err := f.service(t).Register(t.Context(), f.request)
		requireIncarnationServiceFailure(t, err, "acp_registration_unavailable")
		requireIncarnationServiceEqual(t, got, Registration{}, "missing or invalid destination returned a registration")
		if incarnationServiceHasCall(f.calls.snapshot(), "probe") {
			t.Error("registration dispatched a probe without its inspected destination")
		}
		requireIncarnationServiceNoWrites(t, f)
	}
}

func TestRegisterRejectsPlatformChangesAndObservationFailures(t *testing.T) {
	for _, change := range []string{"engine", "container", "start", "address", "running", "initial_engine_error", "initial_inspect_error", "recheck_engine_error", "recheck_inspect_error"} {
		t.Run(change, func(t *testing.T) {
			f := newIncarnationServiceFixture(t)
			engineCalls, inspectCalls := 0, 0
			f.platform.engine = func(context.Context) (string, error) {
				engineCalls++
				if change == "initial_engine_error" || change == "recheck_engine_error" && engineCalls > 1 {
					return "", errors.New("fixture engine inspection failed")
				}
				if change == "engine" && engineCalls > 1 {
					return "engine-replaced", nil
				}
				return f.record.Binding.EngineID, nil
			}
			f.platform.inspect = func(context.Context, string, string) (Observation, error) {
				inspectCalls++
				if change == "initial_inspect_error" || change == "recheck_inspect_error" && inspectCalls > 1 {
					return Observation{}, errors.New("fixture container inspection failed")
				}
				observed := f.observation
				if inspectCalls > 1 {
					switch change {
					case "container":
						observed.ContainerID = strings.Repeat("b", 64)
					case "start":
						observed.StartedAt = "2025-03-03T01:02:03.123456789Z"
					case "address":
						observed.Address = "172.30.1.25"
					case "running":
						observed.Running = false
					}
				}
				return observed, nil
			}
			got, err := f.service(t).Register(t.Context(), f.request)
			requireIncarnationServiceFailure(t, err, "acp_registration_unavailable")
			requireIncarnationServiceEqual(t, got, Registration{}, "changed platform returned a registration")
			requireIncarnationServiceNoWrites(t, f)
		})
	}
}

func TestRegisterRejectsUnknownMemberOnlyAfterOriginalReceiptLookup(t *testing.T) {
	f := newIncarnationServiceFixture(t)
	request := f.request
	request.MemberID = "acp-not-configured"
	got, err := f.service(t).Register(t.Context(), request)
	requireIncarnationServiceFailure(t, err, "acp_member_not_allowed")
	requireIncarnationServiceEqual(t, got, Registration{}, "unconfigured member returned a registration")
	requireIncarnationServiceEqual(t, f.calls.snapshot(), []string{"find"}, "unconfigured member skipped receipt lookup or reached platform work")
}

func TestIncarnationServiceRejectsMalformedInputsBeforeDependencies(t *testing.T) {
	cases := []struct {
		name   string
		change func(*RegisterRequest)
	}{
		{"empty_member", func(r *RegisterRequest) { r.MemberID = "" }},
		{"member_case", func(r *RegisterRequest) { r.MemberID = "ACP-A" }},
		{"member_whitespace", func(r *RegisterRequest) { r.MemberID = " acp-a" }},
		{"member_length", func(r *RegisterRequest) { r.MemberID = strings.Repeat("a", 65) }},
		{"incarnation_version", func(r *RegisterRequest) { r.IncarnationID = "aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa" }},
		{"incarnation_case", func(r *RegisterRequest) { r.IncarnationID = strings.ToUpper(r.IncarnationID) }},
		{"nonce_length", func(r *RegisterRequest) { r.RegistrationNonce = strings.Repeat("a", 63) }},
		{"nonce_case", func(r *RegisterRequest) { r.RegistrationNonce = strings.Repeat("A", 64) }},
		{"nonce_not_hex", func(r *RegisterRequest) { r.RegistrationNonce = strings.Repeat("z", 64) }},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			f := newIncarnationServiceFixture(t)
			request := f.request
			item.change(&request)
			got, err := f.service(t).Register(t.Context(), request)
			requireIncarnationServiceFailure(t, err, "invalid_request")
			requireIncarnationServiceEqual(t, got, Registration{}, "malformed registration returned a receipt")
			if len(f.calls.snapshot()) != 0 {
				t.Error("malformed registration reached a dependency")
			}
		})
	}
	for _, id := range []string{"", "not-a-uuid", "bbbbbbbb-bbbb-1bbb-8bbb-bbbbbbbbbbbb"} {
		t.Run("inspect_"+id, func(t *testing.T) {
			f := newIncarnationServiceFixture(t)
			got, err := f.service(t).Inspect(t.Context(), id)
			requireIncarnationServiceFailure(t, err, "invalid_request")
			requireIncarnationServiceEqual(t, got, Inspection{}, "malformed lookup returned an inspection")
			if len(f.calls.snapshot()) != 0 {
				t.Error("malformed registration identifier reached a dependency")
			}
		})
	}
}

func TestInspectUnregisteredIdentityDoesNotQueryPlatform(t *testing.T) {
	f := newIncarnationServiceFixture(t)
	f.store.get = func(_ context.Context, scope, id string) (*Record, error) {
		if scope != f.scope || id != f.record.Registration.RegistrationID {
			t.Error("inspection lookup changed the configured scope or registration")
		}
		return nil, nil
	}
	got, err := f.service(t).Inspect(t.Context(), f.record.Registration.RegistrationID)
	if err != nil {
		t.Fatal("unregistered inspection failed")
	}
	requireIncarnationServiceEqual(t, got, incarnationServiceUnknown(f, "unregistered"), "unregistered lookup fabricated a binding or stopped receipt")
	requireIncarnationServiceEqual(t, f.calls.snapshot(), []string{"get"}, "unregistered lookup queried the platform")
}

func TestInspectReturnsPersistedStopBeforeMembershipOrPlatform(t *testing.T) {
	f := newIncarnationServiceFixture(t)
	f.members = nil
	receipt := incarnationServiceStoredReceipt()
	f.record.Stop = &receipt
	f.platform.engine = func(context.Context) (string, error) {
		return "", errors.New("fixture unavailable engine must not be consulted")
	}
	got, err := f.service(t).Inspect(t.Context(), f.record.Registration.RegistrationID)
	if err != nil {
		t.Fatal("persisted stop inspection failed")
	}
	requireIncarnationServiceEqual(t, got, incarnationServiceStopped(f.record), "persisted stop receipt or its original binding changed")
	requireIncarnationServiceEqual(t, f.calls.snapshot(), []string{"get"}, "persisted stopped fact depended on current membership or platform availability")
}

func TestInspectChangedEngineIsUnknownWithoutInspectingAnotherEngine(t *testing.T) {
	f := newIncarnationServiceFixture(t)
	f.platform.engine = func(context.Context) (string, error) { return "engine-replaced", nil }
	got, err := f.service(t).Inspect(t.Context(), f.record.Registration.RegistrationID)
	if err != nil {
		t.Fatal("changed engine inspection failed")
	}
	requireIncarnationServiceEqual(t, got, incarnationServiceUnknown(f, "engine_changed"), "engine change fabricated a stopped receipt")
	requireIncarnationServiceEqual(t, f.calls.snapshot(), []string{"get", "engine"}, "changed engine caused a foreign container lookup or mutation")
}

func TestInspectPlatformFailureRemainsUnknown(t *testing.T) {
	for _, stage := range []string{"engine", "container"} {
		t.Run(stage, func(t *testing.T) {
			f := newIncarnationServiceFixture(t)
			if stage == "engine" {
				f.platform.engine = func(context.Context) (string, error) {
					return "", errors.New("fixture engine unavailable")
				}
			} else {
				f.platform.inspect = func(context.Context, string, string) (Observation, error) {
					return Observation{}, errors.New("fixture platform unavailable")
				}
			}
			got, err := f.service(t).Inspect(t.Context(), f.record.Registration.RegistrationID)
			if err != nil {
				t.Fatal("platform uncertainty was not represented as unknown")
			}
			requireIncarnationServiceEqual(t, got, incarnationServiceUnknown(f, "platform_unavailable"), "platform failure fabricated a stopped receipt")
			requireIncarnationServiceNoWrites(t, f)
		})
	}
}

func TestInspectMissingMembershipRemainsUnknown(t *testing.T) {
	f := newIncarnationServiceFixture(t)
	f.members = nil
	got, err := f.service(t).Inspect(t.Context(), f.record.Registration.RegistrationID)
	if err != nil {
		t.Fatal("missing membership inspection failed")
	}
	requireIncarnationServiceEqual(t, got, incarnationServiceUnknown(f, "membership_unavailable"), "missing membership fabricated a stop fact")
	requireIncarnationServiceEqual(t, f.calls.snapshot(), []string{"get"}, "missing member selected a platform destination")
}

func TestInspectPersistsOnlyExactRegisteredPositiveStopFacts(t *testing.T) {
	for _, reason := range []string{"container_stopped", "container_restarted", "container_removed"} {
		t.Run(reason, func(t *testing.T) {
			f := newIncarnationServiceFixture(t)
			f.platform.inspect = func(_ context.Context, selector, network string) (Observation, error) {
				if selector != f.record.Binding.ContainerID || network != f.member.Network {
					t.Error("stop inspection used a reusable member selector instead of the registered full container")
				}
				observed := f.observation
				switch reason {
				case "container_stopped":
					observed.Running = false
				case "container_restarted":
					observed.StartedAt = "2025-03-03T01:02:03.123456789Z"
				case "container_removed":
					return Observation{}, ErrContainerNotFound
				}
				return observed, nil
			}
			var stored *Record
			f.store.stop = func(_ context.Context, scope, id string, binding Binding, receipt StopReceipt) (Record, error) {
				if scope != f.scope || id != f.record.Registration.RegistrationID {
					t.Error("stop recording changed its configured scope or registration")
				}
				requireIncarnationServiceEqual(t, binding, f.record.Binding, "stop recording did not bind the original engine/container/start")
				if receipt.Reason != reason || !incarnationServiceUUID.MatchString(receipt.ReceiptID) || receipt.ObservedAt.IsZero() {
					t.Error("stop candidate did not describe the positive platform observation")
				}
				_, offset := receipt.ObservedAt.Zone()
				if offset != 0 {
					t.Error("stop receipt observation time is not UTC")
				}
				value := f.record
				value.Stop = &receipt
				stored = cloneIncarnationServiceRecord(&value)
				return value, nil
			}
			got, err := f.service(t).Inspect(t.Context(), f.record.Registration.RegistrationID)
			if err != nil || stored == nil {
				t.Fatal("positive stop observation was not durably recorded")
			}
			requireIncarnationServiceEqual(t, got, incarnationServiceStopped(*stored), "inspection lost the persisted stop receipt's original binding")
			if incarnationServiceCallCount(f.calls.snapshot(), "stop") != 1 {
				t.Error("inspection duplicated the stop persistence request")
			}
		})
	}
}

func TestInspectDoesNotReportStoppedWhenReceiptPersistenceFails(t *testing.T) {
	f := newIncarnationServiceFixture(t)
	f.platform.inspect = func(context.Context, string, string) (Observation, error) {
		observed := f.observation
		observed.Running = false
		return observed, nil
	}
	f.store.stop = func(context.Context, string, string, Binding, StopReceipt) (Record, error) {
		return Record{}, errors.New("fixture stop receipt commit failed")
	}
	got, err := f.service(t).Inspect(t.Context(), f.record.Registration.RegistrationID)
	requireIncarnationServiceFailure(t, err, "acp_registry_unavailable")
	requireIncarnationServiceEqual(t, got, Inspection{}, "uncommitted stop observation escaped as a successful fact")
	if incarnationServiceCallCount(f.calls.snapshot(), "stop") != 1 {
		t.Error("positive stop did not reach the failing persistence boundary")
	}
}

func TestInspectReturnsConcurrentFirstStopReceiptUnchanged(t *testing.T) {
	f := newIncarnationServiceFixture(t)
	f.platform.inspect = func(context.Context, string, string) (Observation, error) {
		observed := f.observation
		observed.Running = false
		return observed, nil
	}
	winner := f.record
	receipt := incarnationServiceStoredReceipt()
	winner.Stop = &receipt
	f.store.stop = func(_ context.Context, _ string, _ string, expected Binding, candidate StopReceipt) (Record, error) {
		requireIncarnationServiceEqual(t, expected, winner.Binding, "stop race changed the original platform binding")
		if candidate.Reason != "container_stopped" {
			t.Error("stop race did not attempt to persist its actual observation")
		}
		return *cloneIncarnationServiceRecord(&winner), nil
	}
	got, err := f.service(t).Inspect(t.Context(), f.record.Registration.RegistrationID)
	if err != nil {
		t.Fatal("concurrent first stop receipt was not adopted")
	}
	requireIncarnationServiceEqual(t, got, incarnationServiceStopped(winner), "later stop candidate overwrote the concurrent winner's receipt or observation time")
}

func TestRegisterCancellationWaitsForActualHeldProbeCompletion(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newIncarnationServiceFixture(t)
		entered, aborted, release, exited, returned := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
		ctx, cancel := context.WithCancel(t.Context())
		var releaseOnce sync.Once
		var got Registration
		var resultErr error
		f.prober.probe = func(ctx context.Context, _ Member, _ Observation, _ ProbeRequest) (ProbeRequest, error) {
			close(entered)
			defer close(exited)
			select {
			case <-ctx.Done():
				close(aborted)
			case <-release:
				return ProbeRequest{}, errors.New("fixture released an uncancelled probe")
			}
			<-release
			return ProbeRequest{}, ctx.Err()
		}
		service := f.service(t)
		go func() {
			defer close(returned)
			got, resultErr = service.Register(ctx, f.request)
		}()
		defer func() {
			cancel()
			releaseOnce.Do(func() { close(release) })
			<-returned
			select {
			case <-entered:
				<-exited
			default:
			}
		}()
		synctest.Wait()
		select {
		case <-entered:
		default:
			t.Fatal("registration did not enter the held probe")
		}
		cancel()
		synctest.Wait()
		select {
		case <-aborted:
		default:
			t.Error("parent cancellation did not reach the actual probe")
		}
		select {
		case <-returned:
			t.Error("registration returned before the cancelled probe actually settled")
		default:
		}
		select {
		case <-exited:
			t.Error("held probe exited without the explicit release")
		default:
		}
		requireIncarnationServiceNoWrites(t, f)
		releaseOnce.Do(func() { close(release) })
		<-returned
		<-exited
		if resultErr == nil {
			t.Error("cancelled registration returned success")
		}
		requireIncarnationServiceEqual(t, got, Registration{}, "cancelled probe returned a registration")
		requireIncarnationServiceNoWrites(t, f)
	})
}

func TestRegisterChecksCancellationAfterSuccessfulPortReturns(t *testing.T) {
	for _, stage := range []string{"find_existing", "find_miss", "register_commit", "initial_engine"} {
		t.Run(stage, func(t *testing.T) {
			f := newIncarnationServiceFixture(t)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			callbackReturned := false
			switch stage {
			case "find_existing", "find_miss":
				f.store.find = func(context.Context, string, string, string) (*Record, error) {
					defer func() { callbackReturned = true }()
					cancel()
					if stage == "find_existing" {
						return cloneIncarnationServiceRecord(&f.record), nil
					}
					return nil, nil
				}
			case "register_commit":
				f.store.register = func(_ context.Context, record Record) (Record, error) {
					defer func() { callbackReturned = true }()
					cancel()
					return record, nil
				}
			case "initial_engine":
				f.platform.engine = func(context.Context) (string, error) {
					defer func() { callbackReturned = true }()
					cancel()
					return f.record.Binding.EngineID, nil
				}
			}
			got, err := f.service(t).Register(ctx, f.request)
			if !callbackReturned {
				t.Fatal("registration did not join the successful port callback")
			}
			requireIncarnationServiceFailure(t, err, "deadline_exceeded")
			requireIncarnationServiceEqual(t, got, Registration{}, "cancelled port return escaped as a registration receipt")
			calls := f.calls.snapshot()
			switch stage {
			case "find_existing", "find_miss":
				requireIncarnationServiceEqual(t, calls, []string{"find"}, "cancelled registration lookup continued to a downstream dependency")
			case "initial_engine":
				requireIncarnationServiceEqual(t, calls, []string{"find", "engine"}, "cancelled engine lookup continued to inspect or probe")
			case "register_commit":
				if incarnationServiceCallCount(calls, "register") != 1 || calls[len(calls)-1] != "register" {
					t.Error("cancelled registration commit was repeated or followed by more work")
				}
			}
		})
	}
}

func TestInspectChecksCancellationAfterSuccessfulRegistryReturns(t *testing.T) {
	for _, stage := range []string{"get_stopped", "get_miss", "record_stop"} {
		t.Run(stage, func(t *testing.T) {
			f := newIncarnationServiceFixture(t)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			callbackReturned := false
			if stage == "record_stop" {
				f.platform.inspect = func(context.Context, string, string) (Observation, error) {
					observed := f.observation
					observed.Running = false
					return observed, nil
				}
				f.store.stop = func(_ context.Context, _ string, _ string, _ Binding, receipt StopReceipt) (Record, error) {
					defer func() { callbackReturned = true }()
					record := f.record
					record.Stop = &receipt
					cancel()
					return record, nil
				}
			} else {
				f.store.get = func(context.Context, string, string) (*Record, error) {
					defer func() { callbackReturned = true }()
					cancel()
					if stage == "get_miss" {
						return nil, nil
					}
					record := f.record
					receipt := incarnationServiceStoredReceipt()
					record.Stop = &receipt
					return cloneIncarnationServiceRecord(&record), nil
				}
			}
			got, err := f.service(t).Inspect(ctx, f.record.Registration.RegistrationID)
			if !callbackReturned {
				t.Fatal("inspection did not join the successful registry callback")
			}
			requireIncarnationServiceFailure(t, err, "deadline_exceeded")
			requireIncarnationServiceEqual(t, got, Inspection{}, "cancelled registry return escaped as an inspection fact")
			calls := f.calls.snapshot()
			if stage != "record_stop" {
				requireIncarnationServiceEqual(t, calls, []string{"get"}, "cancelled registration read continued to downstream work")
			} else if incarnationServiceCallCount(calls, "stop") != 1 || calls[len(calls)-1] != "stop" {
				t.Error("cancelled stop commit was repeated or followed by more work")
			}
		})
	}
}

func TestInspectDistinguishesTimestampSpellingFromNanosecondIdentity(t *testing.T) {
	cases := []struct {
		name       string
		registered string
		observed   string
		restarted  bool
	}{
		{"equivalent_zero_offset", "2025-03-01T01:02:03.123456789Z", "2025-03-01T01:02:03.123456789+00:00", false},
		{"equivalent_fraction_zero", "2025-03-01T01:02:03.12345678Z", "2025-03-01T01:02:03.123456780Z", false},
		{"different_nanosecond", "2025-03-01T01:02:03.123456789Z", "2025-03-01T01:02:03.123456788Z", true},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			f := newIncarnationServiceFixture(t)
			f.record.Binding.StartedAt = item.registered
			f.observation.StartedAt = item.observed
			got, err := f.service(t).Inspect(t.Context(), f.record.Registration.RegistrationID)
			if err != nil {
				t.Fatal("timestamp identity inspection failed")
			}
			if got.RegistrationID != f.record.Registration.RegistrationID {
				t.Error("timestamp inspection changed the original registration")
			}
			if item.restarted {
				if got.State != "stopped" || got.StopReceipt == nil || got.StopReceipt.Reason != "container_restarted" || incarnationServiceCallCount(f.calls.snapshot(), "stop") != 1 {
					t.Error("a genuine nanosecond change did not retain its positive restart fact")
				}
			} else {
				if (got.State != "running" && got.State != "unknown") || got.StopReceipt != nil {
					t.Error("equivalent timestamp spelling fabricated a positive stop fact")
				}
				requireIncarnationServiceNoWrites(t, f)
			}
		})
	}
}

var (
	incarnationServiceUUID  = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	incarnationServiceNonce = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

type incarnationServiceCalls struct {
	mu    sync.Mutex
	names []string
}

func (c *incarnationServiceCalls) add(name string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.names = append(c.names, name)
}

func (c *incarnationServiceCalls) snapshot() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.names...)
}

type incarnationServiceStore struct {
	calls    *incarnationServiceCalls
	find     func(context.Context, string, string, string) (*Record, error)
	get      func(context.Context, string, string) (*Record, error)
	register func(context.Context, Record) (Record, error)
	stop     func(context.Context, string, string, Binding, StopReceipt) (Record, error)
}

func (s *incarnationServiceStore) FindRegistration(ctx context.Context, scope, member, incarnation string) (*Record, error) {
	s.calls.add("find")
	return s.find(ctx, scope, member, incarnation)
}

func (s *incarnationServiceStore) GetRegistration(ctx context.Context, scope, id string) (*Record, error) {
	s.calls.add("get")
	return s.get(ctx, scope, id)
}

func (s *incarnationServiceStore) RegisterVerified(ctx context.Context, record Record) (Record, error) {
	s.calls.add("register")
	return s.register(ctx, record)
}

func (s *incarnationServiceStore) RecordStopped(ctx context.Context, scope, id string, binding Binding, receipt StopReceipt) (Record, error) {
	s.calls.add("stop")
	return s.stop(ctx, scope, id, binding, receipt)
}

type incarnationServicePlatform struct {
	calls   *incarnationServiceCalls
	engine  func(context.Context) (string, error)
	inspect func(context.Context, string, string) (Observation, error)
}

func (p *incarnationServicePlatform) EngineID(ctx context.Context) (string, error) {
	p.calls.add("engine")
	return p.engine(ctx)
}

func (p *incarnationServicePlatform) Inspect(ctx context.Context, selector, network string) (Observation, error) {
	p.calls.add("inspect")
	return p.inspect(ctx, selector, network)
}

type incarnationServiceProber struct {
	calls *incarnationServiceCalls
	probe func(context.Context, Member, Observation, ProbeRequest) (ProbeRequest, error)
}

func (p *incarnationServiceProber) Probe(ctx context.Context, member Member, observed Observation, request ProbeRequest) (ProbeRequest, error) {
	p.calls.add("probe")
	return p.probe(ctx, member, observed, request)
}

type incarnationServiceFixture struct {
	scope       string
	member      Member
	members     []Member
	request     RegisterRequest
	record      Record
	observation Observation
	calls       *incarnationServiceCalls
	store       *incarnationServiceStore
	platform    *incarnationServicePlatform
	prober      *incarnationServiceProber
}

func newIncarnationServiceFixture(t *testing.T) *incarnationServiceFixture {
	t.Helper()
	f := &incarnationServiceFixture{
		scope:   "controller-scope-a",
		member:  Member{ID: "acp-a", Selector: "owned-acp-a", Network: "acp-owner", Origin: "http://acp-a:8082"},
		request: RegisterRequest{MemberID: "acp-a", IncarnationID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", RegistrationNonce: strings.Repeat("a", 64)},
		calls:   &incarnationServiceCalls{},
	}
	f.members = []Member{f.member}
	f.record = Record{
		Scope:        f.scope,
		Registration: Registration{RegistrationID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", MemberID: f.request.MemberID, IncarnationID: f.request.IncarnationID},
		NonceDigest:  sha256.Sum256([]byte(f.request.RegistrationNonce)),
		Binding:      Binding{EngineID: "engine-a", ContainerID: strings.Repeat("a", 64), StartedAt: "2025-03-01T01:02:03.123456789Z"},
	}
	f.observation = Observation{ContainerID: f.record.Binding.ContainerID, StartedAt: f.record.Binding.StartedAt, Address: "172.30.1.24", Running: true}
	f.store = &incarnationServiceStore{
		calls: f.calls,
		find:  func(context.Context, string, string, string) (*Record, error) { return nil, nil },
		get: func(context.Context, string, string) (*Record, error) {
			return cloneIncarnationServiceRecord(&f.record), nil
		},
		register: func(_ context.Context, record Record) (Record, error) { return record, nil },
		stop: func(_ context.Context, _ string, _ string, _ Binding, receipt StopReceipt) (Record, error) {
			record := f.record
			record.Stop = &receipt
			return record, nil
		},
	}
	f.platform = &incarnationServicePlatform{
		calls:  f.calls,
		engine: func(context.Context) (string, error) { return f.record.Binding.EngineID, nil },
		inspect: func(_ context.Context, selector, network string) (Observation, error) {
			if (selector != f.member.Selector && selector != f.record.Binding.ContainerID) || network != f.member.Network {
				t.Error("platform lookup used an unconfigured selector or network")
			}
			return f.observation, nil
		},
	}
	f.prober = &incarnationServiceProber{
		calls: f.calls,
		probe: func(_ context.Context, _ Member, _ Observation, request ProbeRequest) (ProbeRequest, error) {
			return request, nil
		},
	}
	return f
}

func (f *incarnationServiceFixture) service(t *testing.T) *Service {
	t.Helper()
	service, err := New(f.scope, f.members, f.store, f.platform, f.prober)
	if err != nil {
		t.Fatal("valid incarnation service fixture was rejected")
	}
	return service
}

func cloneIncarnationServiceRecord(record *Record) *Record {
	if record == nil {
		return nil
	}
	copy := *record
	if record.Stop != nil {
		stop := *record.Stop
		copy.Stop = &stop
	}
	return &copy
}

func incarnationServiceStoredReceipt() StopReceipt {
	return StopReceipt{ReceiptID: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", Reason: "container_removed", ObservedAt: time.Date(2025, time.March, 2, 1, 2, 3, 123456000, time.UTC)}
}

func incarnationServiceUnknown(f *incarnationServiceFixture, reason string) Inspection {
	return Inspection{State: "unknown", RegistrationID: f.record.Registration.RegistrationID, Reason: reason}
}

func incarnationServiceStopped(record Record) Inspection {
	copy := cloneIncarnationServiceRecord(&record)
	return Inspection{State: "stopped", RegistrationID: copy.Registration.RegistrationID, MemberID: copy.Registration.MemberID, IncarnationID: copy.Registration.IncarnationID, StopReceipt: copy.Stop}
}

func requireIncarnationServiceFailure(t *testing.T, err error, code string) {
	t.Helper()
	var failure *Failure
	if !errors.As(err, &failure) || failure.Code != code {
		t.Fatalf("expected typed incarnation failure %s", code)
	}
}

func requireIncarnationServiceEqual(t *testing.T, got, want any, message string) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatal(message)
	}
}

func requireIncarnationServiceNoWrites(t *testing.T, f *incarnationServiceFixture) {
	t.Helper()
	for _, call := range f.calls.snapshot() {
		if call == "register" || call == "stop" {
			t.Error("rejected or unknown observation reached a persistence mutation")
		}
	}
}

func incarnationServiceCallIndex(calls []string, name string) int {
	for index, call := range calls {
		if call == name {
			return index
		}
	}
	return -1
}

func incarnationServiceHasCall(calls []string, name string) bool {
	return incarnationServiceCallIndex(calls, name) >= 0
}

func incarnationServiceCallCount(calls []string, name string) int {
	count := 0
	for _, call := range calls {
		if call == name {
			count++
		}
	}
	return count
}
