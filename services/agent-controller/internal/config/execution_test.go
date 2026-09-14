package config

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestExecutionConfigurationDefaultsAndOverrides(t *testing.T) {
	values := map[string]string{"ANTNEST_AGENT_ACP_SERVICE_URL": "http://agent-acp-service:8090"}
	lookup := func(key string) string { return values[key] }
	config, err := loadExecutionConfiguration(lookup)
	require.NoError(t, err)
	require.Equal(t, ExecutionConfiguration{URL: values["ANTNEST_AGENT_ACP_SERVICE_URL"], MaxBytes: 16777216, ResyncInterval: 30 * time.Second, RetryInterval: time.Second, MaxRetryInterval: 30 * time.Second, RequestTimeout: 15 * time.Second}, config)
	values["ANTNEST_ACP_MAX_CONFIGURATION_BYTES"] = "67108864"
	values["ANTNEST_AGENT_CONTROLLER_EXECUTION_RESYNC_INTERVAL"] = "1m"
	values["ANTNEST_AGENT_CONTROLLER_EXECUTION_RETRY_INTERVAL"] = "2s"
	values["ANTNEST_AGENT_CONTROLLER_EXECUTION_MAX_RETRY_INTERVAL"] = "20s"
	values["ANTNEST_AGENT_CONTROLLER_EXECUTION_REQUEST_TIMEOUT"] = "10s"
	config, err = loadExecutionConfiguration(lookup)
	require.NoError(t, err)
	require.Equal(t, ExecutionConfiguration{URL: values["ANTNEST_AGENT_ACP_SERVICE_URL"], MaxBytes: 67108864, ResyncInterval: time.Minute, RetryInterval: 2 * time.Second, MaxRetryInterval: 20 * time.Second, RequestTimeout: 10 * time.Second}, config)
}

func TestExecutionConfigurationRejectsInvalidLimitOriginAndSchedule(t *testing.T) {
	for _, sample := range []struct{ key, value string }{
		{"ANTNEST_AGENT_ACP_SERVICE_URL", ""}, {"ANTNEST_AGENT_ACP_SERVICE_URL", "file:///tmp/acp"},
		{"ANTNEST_AGENT_ACP_SERVICE_URL", "http://user:secret@acp"}, {"ANTNEST_AGENT_ACP_SERVICE_URL", "http://acp/other"},
		{"ANTNEST_ACP_MAX_CONFIGURATION_BYTES", "0"}, {"ANTNEST_ACP_MAX_CONFIGURATION_BYTES", "67108865"},
		{"ANTNEST_ACP_MAX_CONFIGURATION_BYTES", "NaN"}, {"ANTNEST_AGENT_CONTROLLER_EXECUTION_RESYNC_INTERVAL", "0s"},
		{"ANTNEST_AGENT_CONTROLLER_EXECUTION_RETRY_INTERVAL", "no"}, {"ANTNEST_AGENT_CONTROLLER_EXECUTION_MAX_RETRY_INTERVAL", "500ms"},
		{"ANTNEST_AGENT_CONTROLLER_EXECUTION_REQUEST_TIMEOUT", "-1s"},
	} {
		t.Run(sample.key+"/"+sample.value, func(t *testing.T) {
			values := map[string]string{"ANTNEST_AGENT_ACP_SERVICE_URL": "http://agent-acp-service:8090", sample.key: sample.value}
			_, err := loadExecutionConfiguration(func(key string) string { return values[key] })
			require.Error(t, err)
			require.NotContains(t, err.Error(), "user:secret")
		})
	}
}
