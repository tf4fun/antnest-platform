package config

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestLifecycleReliabilityConfiguration(t *testing.T) {
	load := func(values map[string]string) (LifecycleReliabilityConfiguration, error) {
		return loadLifecycleReliabilityConfiguration(func(key string) string { return values[key] })
	}
	defaults, err := load(nil)
	require.NoError(t, err)
	require.Equal(t, 10*time.Minute, defaults.PhaseDeadlines["network_ensure"])
	require.Equal(t, 30*time.Minute, defaults.PhaseDeadlines["runtime_initialize"])
	require.Equal(t, 10*time.Minute, defaults.PhaseDeadlines["publish"])
	require.Equal(t, 10*time.Minute, defaults.PhaseDeadlines["default"])
	require.Equal(t, 7*24*time.Hour, defaults.FailedCreateTTL)
	require.Equal(t, time.Hour, defaults.FailedCreateGCInterval)

	overrides, err := load(map[string]string{
		"ANTNEST_AGENT_CONTROLLER_PHASE_DEADLINES":           `{"network_ensure":"2s","drain":"3m"}`,
		"ANTNEST_AGENT_CONTROLLER_FAILED_CREATE_TTL":         "2d",
		"ANTNEST_AGENT_CONTROLLER_FAILED_CREATE_GC_INTERVAL": "15m",
		"ANTNEST_AGENT_CONTROLLER_WORKER_BUILD_ID":           " release-45 ",
	})
	require.NoError(t, err)
	require.Equal(t, 2*time.Second, overrides.PhaseDeadlines["network_ensure"])
	require.Equal(t, 3*time.Minute, overrides.PhaseDeadlines["drain"])
	require.Equal(t, defaults.PhaseDeadlines["publish"], overrides.PhaseDeadlines["publish"])
	require.Equal(t, 48*time.Hour, overrides.FailedCreateTTL)
	require.Equal(t, "release-45", overrides.WorkerBuildID)

	disabled, err := load(map[string]string{"ANTNEST_AGENT_CONTROLLER_FAILED_CREATE_TTL": "0"})
	require.NoError(t, err)
	require.Zero(t, disabled.FailedCreateTTL)
}

func TestLifecycleReliabilityConfigurationLoadsThroughLoad(t *testing.T) {
	loaded, err := loadRuntimeBarrierRecoveryTestConfig(t, map[string]string{
		"ANTNEST_AGENT_CONTROLLER_FAILED_CREATE_TTL":         "2d",
		"ANTNEST_AGENT_CONTROLLER_FAILED_CREATE_GC_INTERVAL": "15m",
		"ANTNEST_AGENT_CONTROLLER_WORKER_BUILD_ID":           " release-45 ",
	})
	require.NoError(t, err)
	require.Equal(t, 48*time.Hour, loaded.LifecycleReliability.FailedCreateTTL)
	require.Equal(t, 15*time.Minute, loaded.LifecycleReliability.FailedCreateGCInterval)
	require.Equal(t, "release-45", loaded.LifecycleReliability.WorkerBuildID)
	require.Equal(t, 10*time.Minute, loaded.LifecycleReliability.PhaseDeadlines["network_ensure"])

	_, err = loadRuntimeBarrierRecoveryTestConfig(t, map[string]string{
		"ANTNEST_AGENT_CONTROLLER_PHASE_DEADLINES": `{"completed":"1m"}`,
	})
	require.ErrorContains(t, err, "ANTNEST_AGENT_CONTROLLER_PHASE_DEADLINES")
}

func TestLifecycleReliabilityRejectsInvalidConfiguration(t *testing.T) {
	for key, values := range map[string][]string{
		"PHASE_DEADLINES":           {`null`, `[]`, `{"unknown":"1m"}`, `{"publish":"0s"}`, `{"publish":"-1s"}`, `{"publish":600}`, `{"publish":"invalid"}`, `{} trailing`},
		"FAILED_CREATE_TTL":         {"-1s", "invalid", "999999999999999d"},
		"FAILED_CREATE_GC_INTERVAL": {"0", "-1m", "invalid"},
	} {
		for _, value := range values {
			t.Run(key+"/"+value, func(t *testing.T) {
				name := "ANTNEST_AGENT_CONTROLLER_" + key
				_, err := loadLifecycleReliabilityConfiguration(func(k string) string {
					if k == name {
						return value
					}
					return ""
				})
				require.ErrorContains(t, err, name)
			})
		}
	}
}
