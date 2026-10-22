package config

import (
	"encoding/base64"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

const (
	runtimeBarrierRecoveryPollEnv  = "ANTNEST_AGENT_CONTROLLER_RUNTIME_BARRIER_RECOVERY_POLL_INTERVAL"
	runtimeBarrierRecoveryRoundEnv = "ANTNEST_AGENT_CONTROLLER_RUNTIME_BARRIER_RECOVERY_ROUND_TIMEOUT"
	runtimeBarrierRecoveryBatchEnv = "ANTNEST_AGENT_CONTROLLER_RUNTIME_BARRIER_RECOVERY_BATCH_SIZE"
)

func TestRuntimeBarrierRecoveryConfigurationDefaultsAndOverrides(t *testing.T) {
	defaults := RuntimeBarrierRecoveryConfiguration{PollInterval: 2 * time.Second, RoundTimeout: 10 * time.Second, BatchSize: 100}
	for _, scenario := range []struct {
		name   string
		values map[string]string
		want   RuntimeBarrierRecoveryConfiguration
	}{
		{"unset", nil, defaults},
		{"present empty", map[string]string{
			runtimeBarrierRecoveryPollEnv: "", runtimeBarrierRecoveryRoundEnv: "", runtimeBarrierRecoveryBatchEnv: "",
		}, defaults},
		{"whitespace defaults", map[string]string{
			runtimeBarrierRecoveryPollEnv: " \t\r\n", runtimeBarrierRecoveryRoundEnv: "\t ", runtimeBarrierRecoveryBatchEnv: " \n",
		}, defaults},
		{"all overrides", map[string]string{
			runtimeBarrierRecoveryPollEnv: "250ms", runtimeBarrierRecoveryRoundEnv: "7s", runtimeBarrierRecoveryBatchEnv: "250",
		}, RuntimeBarrierRecoveryConfiguration{PollInterval: 250 * time.Millisecond, RoundTimeout: 7 * time.Second, BatchSize: 250}},
		{"trimmed overrides", map[string]string{
			runtimeBarrierRecoveryPollEnv: " \t3s\n", runtimeBarrierRecoveryRoundEnv: "\r 11s \t", runtimeBarrierRecoveryBatchEnv: " 17 ",
		}, RuntimeBarrierRecoveryConfiguration{PollInterval: 3 * time.Second, RoundTimeout: 11 * time.Second, BatchSize: 17}},
		{"minimum positive durations and batch", map[string]string{
			runtimeBarrierRecoveryPollEnv: "1ns", runtimeBarrierRecoveryRoundEnv: "1ns", runtimeBarrierRecoveryBatchEnv: "1",
		}, RuntimeBarrierRecoveryConfiguration{PollInterval: time.Nanosecond, RoundTimeout: time.Nanosecond, BatchSize: 1}},
		{"maximum representable durations and batch", map[string]string{
			runtimeBarrierRecoveryPollEnv:  "2562047h47m16.854775807s",
			runtimeBarrierRecoveryRoundEnv: "9223372036854775807ns", runtimeBarrierRecoveryBatchEnv: "1000",
		}, RuntimeBarrierRecoveryConfiguration{PollInterval: time.Duration(1<<63 - 1), RoundTimeout: time.Duration(1<<63 - 1), BatchSize: 1000}},
		{"poll only", map[string]string{runtimeBarrierRecoveryPollEnv: "4s"},
			RuntimeBarrierRecoveryConfiguration{PollInterval: 4 * time.Second, RoundTimeout: defaults.RoundTimeout, BatchSize: defaults.BatchSize}},
		{"round only", map[string]string{runtimeBarrierRecoveryRoundEnv: "12s"},
			RuntimeBarrierRecoveryConfiguration{PollInterval: defaults.PollInterval, RoundTimeout: 12 * time.Second, BatchSize: defaults.BatchSize}},
		{"batch only", map[string]string{runtimeBarrierRecoveryBatchEnv: "2"},
			RuntimeBarrierRecoveryConfiguration{PollInterval: defaults.PollInterval, RoundTimeout: defaults.RoundTimeout, BatchSize: 2}},
		{"fractional duration", map[string]string{runtimeBarrierRecoveryPollEnv: "1.5s", runtimeBarrierRecoveryRoundEnv: "2500ms"},
			RuntimeBarrierRecoveryConfiguration{PollInterval: 1500 * time.Millisecond, RoundTimeout: 2500 * time.Millisecond, BatchSize: defaults.BatchSize}},
		{"independent positive schedules", map[string]string{runtimeBarrierRecoveryPollEnv: "30s", runtimeBarrierRecoveryRoundEnv: "1s"},
			RuntimeBarrierRecoveryConfiguration{PollInterval: 30 * time.Second, RoundTimeout: time.Second, BatchSize: defaults.BatchSize}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			loaded, err := loadRuntimeBarrierRecoveryTestConfig(t, scenario.values)
			require.NoError(t, err)
			require.Equal(t, scenario.want, loaded.RuntimeBarrierRecovery)
		})
	}
}

func TestRuntimeBarrierRecoveryConfigurationRejectsInvalidDurations(t *testing.T) {
	for _, key := range []string{runtimeBarrierRecoveryPollEnv, runtimeBarrierRecoveryRoundEnv} {
		for _, sample := range []struct{ name, value string }{
			{"zero without unit", "0"}, {"zero", "0s"}, {"negative zero", "-0s"},
			{"negative", "-1ns"}, {"trimmed negative", " \t-2s\n"},
			{"invalid", "not-a-duration"}, {"missing unit", "1"}, {"internal whitespace", "1 s"},
			{"nonfinite", "NaN"}, {"exponent", "1e3s"},
			{"nanosecond overflow", "9223372036854775808ns"},
			{"compound overflow", "2562047h47m16.854775808s"},
		} {
			t.Run(key+"/"+sample.name, func(t *testing.T) {
				_, err := loadRuntimeBarrierRecoveryTestConfig(t, map[string]string{key: sample.value})
				require.Error(t, err)
				require.Contains(t, err.Error(), key)
			})
		}
	}
}

func TestRuntimeBarrierRecoveryConfigurationRejectsInvalidBatch(t *testing.T) {
	for _, sample := range []struct{ name, value string }{
		{"zero", "0"}, {"negative", "-1"}, {"trimmed zero", " \t0\n"}, {"above maximum", "1001"},
		{"fraction", "1.5"}, {"invalid", "not-a-number"}, {"nonfinite", "NaN"},
		{"exponent", "1e2"}, {"internal whitespace", "1 0"},
		{"integer overflow", "9223372036854775808"}, {"negative overflow", "-9223372036854775809"},
	} {
		t.Run(sample.name, func(t *testing.T) {
			_, err := loadRuntimeBarrierRecoveryTestConfig(t, map[string]string{runtimeBarrierRecoveryBatchEnv: sample.value})
			require.Error(t, err)
			require.Contains(t, err.Error(), runtimeBarrierRecoveryBatchEnv)
		})
	}
}

func loadRuntimeBarrierRecoveryTestConfig(t *testing.T, overrides map[string]string) (Config, error) {
	t.Helper()
	values := map[string]string{
		"ANTNEST_AGENT_ACP_CONTROL_URL":           "http://agent-acp-service:8090",
		"ANTNEST_AGENT_CONTROLLER_DATABASE_URL":   "postgres://controller:secret@postgres/controller",
		"ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY": base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")),
		"ANTNEST_RUNTIME_EGRESS_URL":              "http://runtime-egress:8081",
		"ANTNEST_RUNTIME_CONTROLLER_URL":          "http://runtime-controller:8080",
		"ANTNEST_IDENTITY_SERVICE_URL":            "http://identity-service:8080",
	}
	for key, value := range authenticationEnvironment(t) {
		values[key] = value
	}
	for key, value := range overrides {
		values[key] = value
	}
	// Preserve LookupEnv's presence bit so present-empty and absent settings are
	// separate Load inputs while reusing the existing outbound-auth fixture.
	loaded, err := Load(func(key string) (string, bool) {
		value, present := values[key]
		return value, present
	})
	if loaded.Authentication != nil {
		t.Cleanup(loaded.Authentication.CloseIdleConnections)
	}
	return loaded, err
}
