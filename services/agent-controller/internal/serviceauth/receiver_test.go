package serviceauth

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

type tokenFixtures struct {
	ReceiverConfigurations map[string]map[string][]string `json:"receiver_configurations"`
	ConfigurationVectors   []struct {
		Name        string `json:"name"`
		Receiver    string `json:"receiver"`
		SelfAllowed bool   `json:"self_allowed"`
		CallersJSON string `json:"callers_json"`
		Valid       bool   `json:"valid"`
	} `json:"configuration_vectors"`
	TokenVectors []struct {
		Name  string `json:"name"`
		Token string `json:"token"`
		Valid bool   `json:"valid"`
	} `json:"token_vectors"`
	HeaderVectors []struct {
		Name          string   `json:"name"`
		Configuration string   `json:"configuration"`
		Allowed       []string `json:"allowed_callers"`
		Fields        []struct {
			Name  string `json:"name"`
			Value string `json:"value"`
		} `json:"fields"`
		Expected struct {
			Code      *string `json:"code"`
			Status    int     `json:"http_status"`
			Caller    *string `json:"caller"`
			Challenge *string `json:"www_authenticate"`
		} `json:"expected"`
	} `json:"header_vectors"`
}

func readTokenFixtures(t *testing.T) tokenFixtures {
	t.Helper()
	raw, err := os.ReadFile("../../../../contracts/platform/service-token-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures tokenFixtures
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	return fixtures
}

func TestReceiverUsesSharedConfigurationVectors(t *testing.T) {
	for _, vector := range readTokenFixtures(t).ConfigurationVectors {
		t.Run(vector.Name, func(t *testing.T) {
			_, err := ParseReceiver(vector.Receiver, []byte(vector.CallersJSON), vector.SelfAllowed)
			if (err == nil) != vector.Valid {
				t.Fatalf("accepted=%v want=%v error=%v", err == nil, vector.Valid, err)
			}
		})
	}
}

func TestTokenBytesUseSharedCanonicalVectors(t *testing.T) {
	for _, vector := range readTokenFixtures(t).TokenVectors {
		t.Run(vector.Name, func(t *testing.T) {
			if ValidToken([]byte(vector.Token)) != vector.Valid {
				t.Fatalf("token validity differs from shared contract")
			}
		})
	}
}

func TestReceiverUsesSharedHeaderAndRotationVectors(t *testing.T) {
	fixtures := readTokenFixtures(t)
	for _, vector := range fixtures.HeaderVectors {
		t.Run(vector.Name, func(t *testing.T) {
			raw, err := json.Marshal(fixtures.ReceiverConfigurations[vector.Configuration])
			if err != nil {
				t.Fatal(err)
			}
			receiver, err := ParseReceiver("runtime-controller", raw, false)
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodPost, "/internal/probe", nil)
			for _, field := range vector.Fields {
				request.Header.Add(field.Name, field.Value)
			}
			caller, err := receiver.Authorize(request, vector.Allowed)
			status, code, challenge := http.StatusOK, "", ""
			if err != nil {
				var failure *Failure
				if !errors.As(err, &failure) {
					t.Fatalf("non-contract error: %v", err)
				}
				status, code, challenge = failure.Status, failure.Code, failure.Challenge
			}
			wantCaller, wantCode, wantChallenge := "", "", ""
			if vector.Expected.Caller != nil {
				wantCaller = *vector.Expected.Caller
			}
			if vector.Expected.Code != nil {
				wantCode = *vector.Expected.Code
			}
			if vector.Expected.Challenge != nil {
				wantChallenge = *vector.Expected.Challenge
			}
			if status != vector.Expected.Status || code != wantCode || caller != wantCaller || challenge != wantChallenge {
				t.Fatalf("outcome=(%d,%s,%s,%s) want=(%d,%s,%s,%s)", status, code, caller, challenge,
					vector.Expected.Status, wantCode, wantCaller, wantChallenge)
			}
		})
	}
}
