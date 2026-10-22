package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
)

var runtimeRecoveryIdentifier = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$`)
var runtimeRecoveryDate = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$`)

type runtimeRecoveryRequest struct {
	BarrierID               string `json:"barrier_id"`
	ExpectedRuntimeRevision string `json:"expected_runtime_revision"`
}

type runtimeRecoveryProjection struct {
	BarrierID        string  `json:"barrier_id"`
	Reason           string  `json:"reason"`
	RuntimeRevision  string  `json:"runtime_revision"`
	PolicyRevision   int64   `json:"policy_revision"`
	Mode             string  `json:"mode"`
	CooldownMS       int64   `json:"cooldown_ms"`
	RebuildRequestID string  `json:"rebuild_request_id"`
	NotificationID   string  `json:"notification_id"`
	CooldownUntil    *string `json:"cooldown_until"`
}

func runtimeRecoveryBarrierValid(value string) bool {
	length := utf8.RuneCountInString(value)
	return utf8.ValidString(value) && length >= 1 && length <= 200 && strings.IndexFunc(value, oidcWhitespace) < 0
}

func decodeRuntimeRecoveryRequest(response http.ResponseWriter, request *http.Request, raw json.RawMessage) (runtimeRecoveryRequest, string, bool) {
	var recovery runtimeRecoveryRequest
	var wire struct {
		BarrierID               json.RawMessage `json:"barrier_id"`
		ExpectedRuntimeRevision string          `json:"expected_runtime_revision"`
	}
	err := serviceauth.DecodeObject(raw, &wire)
	barrier, barrierErr := parseRuntimeRecoveryBarrier(wire.BarrierID)
	if err != nil || barrierErr != nil || !runtimeRecoveryIdentifier.MatchString(wire.ExpectedRuntimeRevision) {
		writeError(response, http.StatusBadRequest, "invalid_request", "Runtime recovery request is invalid")
		return recovery, "", false
	}
	recovery = runtimeRecoveryRequest{BarrierID: barrier, ExpectedRuntimeRevision: wire.ExpectedRuntimeRevision}
	keys := request.Header.Values("Idempotency-Key")
	if len(keys) != 1 || !runtimeRecoveryIdentifier.MatchString(keys[0]) {
		writeError(response, http.StatusBadRequest, "invalid_idempotency_key", "The original recovery request ID is required")
		return recovery, "", false
	}
	// Controller validates the stable ID against the trusted organization,
	// Agent and original barrier. Do not rehash it or pre-read mutable Agent state.
	return recovery, keys[0], true
}

// JSON's replacement of unpaired surrogate escapes must not change an opaque
// barrier identity. Literal U+FFFD, NUL and paired supplementary scalars remain valid.
func parseRuntimeRecoveryBarrier(raw json.RawMessage) (string, error) {
	var value string
	if !utf8.Valid(raw) || json.Unmarshal(raw, &value) != nil || !runtimeRecoveryBarrierValid(value) {
		return "", fmt.Errorf("invalid Runtime recovery barrier")
	}
	for index := 0; index < len(raw); index++ {
		if raw[index] != '\\' {
			continue
		}
		index++
		if raw[index] != 'u' {
			continue
		}
		code, err := strconv.ParseUint(string(raw[index+1:index+5]), 16, 16)
		if err != nil {
			return "", err
		}
		index += 4
		if code >= 0xdc00 && code <= 0xdfff {
			return "", fmt.Errorf("unpaired barrier surrogate")
		}
		if code < 0xd800 || code > 0xdbff {
			continue
		}
		if index+6 >= len(raw) || raw[index+1] != '\\' || raw[index+2] != 'u' {
			return "", fmt.Errorf("unpaired barrier surrogate")
		}
		low, err := strconv.ParseUint(string(raw[index+3:index+7]), 16, 16)
		if err != nil || low < 0xdc00 || low > 0xdfff {
			return "", fmt.Errorf("unpaired barrier surrogate")
		}
		index += 6
	}
	return value, nil
}

func (source *runtimeRecoveryProjection) UnmarshalJSON(payload []byte) error {
	var fields map[string]json.RawMessage
	if err := serviceauth.DecodeObject(payload, &fields); err != nil {
		return err
	}
	names := []string{"barrier_id", "reason", "runtime_revision", "policy_revision", "mode", "cooldown_ms", "rebuild_request_id", "notification_id", "cooldown_until"}
	for _, name := range names {
		value, exists := fields[name]
		if !exists || (name != "cooldown_until" && bytes.Equal(bytes.TrimSpace(value), []byte("null"))) {
			return fmt.Errorf("missing Runtime recovery field")
		}
		for key := range fields {
			if key != name && strings.EqualFold(key, name) {
				return fmt.Errorf("ambiguous Runtime recovery field")
			}
		}
	}
	if _, err := parseRuntimeRecoveryBarrier(fields["barrier_id"]); err != nil {
		return err
	}
	type wire runtimeRecoveryProjection
	if err := json.Unmarshal(payload, (*wire)(source)); err != nil {
		return err
	}
	if !runtimeRecoveryBarrierValid(source.BarrierID) || source.Reason != "runtime_barrier_required" ||
		!runtimeRecoveryIdentifier.MatchString(source.RuntimeRevision) || !runtimeRecoveryIdentifier.MatchString(source.RebuildRequestID) ||
		!runtimeRecoveryIdentifier.MatchString(source.NotificationID) || source.PolicyRevision < 0 || source.PolicyRevision > int64(maximumBrowserVersion) ||
		(source.Mode != "manual" && source.Mode != "notify" && source.Mode != "auto") || source.CooldownMS < 60000 || source.CooldownMS > 86400000 ||
		(source.PolicyRevision == 0 && (source.Mode != "manual" || source.CooldownMS != 300000)) {
		return fmt.Errorf("invalid Runtime recovery projection")
	}
	if source.CooldownUntil != nil {
		value := *source.CooldownUntil
		date, err := time.Parse(time.RFC3339Nano, value)
		if !runtimeRecoveryDate.MatchString(value) || err != nil || date.IsZero() || date.Year() < 1 {
			return fmt.Errorf("invalid Runtime recovery cooldown")
		}
	}
	return nil
}

func (source *agentProjectionSource) UnmarshalJSON(payload []byte) error {
	var fields map[string]json.RawMessage
	if err := serviceauth.DecodeObject(payload, &fields); err != nil {
		return err
	}
	for key, value := range fields {
		if strings.EqualFold(key, "runtime_recovery") && (key != "runtime_recovery" || bytes.Equal(bytes.TrimSpace(value), []byte("null"))) {
			return fmt.Errorf("invalid Agent Runtime recovery metadata")
		}
	}
	type wire agentProjectionSource
	return json.Unmarshal(payload, (*wire)(source))
}
