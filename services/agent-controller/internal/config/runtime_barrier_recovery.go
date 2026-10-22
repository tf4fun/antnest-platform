package config

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

type RuntimeBarrierRecoveryConfiguration struct {
	PollInterval time.Duration
	RoundTimeout time.Duration
	BatchSize    int
}

func loadRuntimeBarrierRecoveryConfiguration(lookup func(string) string) (RuntimeBarrierRecoveryConfiguration, error) {
	const prefix = "ANTNEST_AGENT_CONTROLLER_RUNTIME_BARRIER_RECOVERY_"
	configuration := RuntimeBarrierRecoveryConfiguration{BatchSize: 100}
	var err error
	configuration.PollInterval, err = positiveDuration(lookup(prefix+"POLL_INTERVAL"), prefix+"POLL_INTERVAL", 2*time.Second)
	if err != nil {
		return RuntimeBarrierRecoveryConfiguration{}, err
	}
	configuration.RoundTimeout, err = positiveDuration(lookup(prefix+"ROUND_TIMEOUT"), prefix+"ROUND_TIMEOUT", 10*time.Second)
	if err != nil {
		return RuntimeBarrierRecoveryConfiguration{}, err
	}
	if raw := strings.TrimSpace(lookup(prefix + "BATCH_SIZE")); raw != "" {
		configuration.BatchSize, err = strconv.Atoi(raw)
		if err != nil || configuration.BatchSize < 1 || configuration.BatchSize > 1000 {
			return RuntimeBarrierRecoveryConfiguration{}, fmt.Errorf("%sBATCH_SIZE must be between 1 and 1000", prefix)
		}
	}
	return configuration, nil
}
