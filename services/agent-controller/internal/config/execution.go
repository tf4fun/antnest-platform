package config

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type ExecutionConfiguration struct {
	URL              string
	MaxBytes         int
	ResyncInterval   time.Duration
	RetryInterval    time.Duration
	MaxRetryInterval time.Duration
	RequestTimeout   time.Duration
}

func loadExecutionConfiguration(lookup func(string) string) (ExecutionConfiguration, error) {
	config := ExecutionConfiguration{URL: strings.TrimSpace(lookup("ANTNEST_AGENT_ACP_CONTROL_URL")), MaxBytes: 16777216}
	endpoint, err := url.Parse(config.URL)
	if err != nil || endpoint.Host == "" || (endpoint.Scheme != "http" && endpoint.Scheme != "https") || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" || (endpoint.Path != "" && endpoint.Path != "/") {
		return ExecutionConfiguration{}, fmt.Errorf("ANTNEST_AGENT_ACP_CONTROL_URL must be an HTTP origin")
	}
	if raw := strings.TrimSpace(lookup("ANTNEST_ACP_MAX_CONFIGURATION_BYTES")); raw != "" {
		config.MaxBytes, err = strconv.Atoi(raw)
		if err != nil || config.MaxBytes < 1024 || config.MaxBytes > 67108864 {
			return ExecutionConfiguration{}, fmt.Errorf("ANTNEST_ACP_MAX_CONFIGURATION_BYTES must be between 1024 and 67108864")
		}
	}
	for _, setting := range []struct {
		key      string
		target   *time.Duration
		fallback time.Duration
	}{
		{"ANTNEST_AGENT_CONTROLLER_EXECUTION_RESYNC_INTERVAL", &config.ResyncInterval, 30 * time.Second},
		{"ANTNEST_AGENT_CONTROLLER_EXECUTION_RETRY_INTERVAL", &config.RetryInterval, time.Second},
		{"ANTNEST_AGENT_CONTROLLER_EXECUTION_MAX_RETRY_INTERVAL", &config.MaxRetryInterval, 30 * time.Second},
		{"ANTNEST_AGENT_CONTROLLER_EXECUTION_REQUEST_TIMEOUT", &config.RequestTimeout, 15 * time.Second},
	} {
		value, err := positiveDuration(lookup(setting.key), setting.key, setting.fallback)
		if err != nil {
			return ExecutionConfiguration{}, err
		}
		*setting.target = value
	}
	if config.MaxRetryInterval < config.RetryInterval {
		return ExecutionConfiguration{}, fmt.Errorf("execution publication maximum retry interval must cover its initial retry interval")
	}
	return config, nil
}
