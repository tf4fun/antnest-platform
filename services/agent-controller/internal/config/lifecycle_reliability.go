package config

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

const (
	lifecyclePhaseDeadlinesEnv  = "ANTNEST_AGENT_CONTROLLER_PHASE_DEADLINES"
	lifecycleFailedCreateTTLEnv = "ANTNEST_AGENT_CONTROLLER_FAILED_CREATE_TTL"
	lifecycleGCIntervalEnv      = "ANTNEST_AGENT_CONTROLLER_FAILED_CREATE_GC_INTERVAL"
	lifecycleWorkerBuildIDEnv   = "ANTNEST_AGENT_CONTROLLER_WORKER_BUILD_ID"
)

type LifecycleReliabilityConfiguration struct {
	PhaseDeadlines         map[string]time.Duration
	FailedCreateTTL        time.Duration
	FailedCreateGCInterval time.Duration
	WorkerBuildID          string
}

func defaultPhaseDeadlines() map[string]time.Duration {
	return map[string]time.Duration{
		"network_ensure":     10 * time.Minute,
		"runtime_initialize": 30 * time.Minute,
		"publish":            10 * time.Minute,
		"default":            10 * time.Minute,
	}
}

func lifecyclePhaseNames() map[string]bool {
	names := map[string]bool{"default": true}
	for _, kind := range []domain.OperationKind{
		domain.OperationCreate, domain.OperationRebuild, domain.OperationDisable,
		domain.OperationEnable, domain.OperationDelete,
	} {
		if plan, err := domain.OperationPlan(kind); err == nil {
			for _, phase := range plan {
				names[string(phase)] = true
			}
		}
	}
	return names
}

func loadLifecycleReliabilityConfiguration(lookup func(string) string) (LifecycleReliabilityConfiguration, error) {
	configuration := LifecycleReliabilityConfiguration{
		PhaseDeadlines:         defaultPhaseDeadlines(),
		FailedCreateTTL:        7 * 24 * time.Hour,
		FailedCreateGCInterval: time.Hour,
		WorkerBuildID:          strings.TrimSpace(lookup(lifecycleWorkerBuildIDEnv)),
	}
	if raw := strings.TrimSpace(lookup(lifecyclePhaseDeadlinesEnv)); raw != "" {
		var overrides map[string]string
		if err := json.Unmarshal([]byte(raw), &overrides); err != nil || overrides == nil {
			return LifecycleReliabilityConfiguration{}, fmt.Errorf(
				"%s must be a JSON object of phase duration overrides", lifecyclePhaseDeadlinesEnv)
		}
		known := lifecyclePhaseNames()
		for phase, value := range overrides {
			if !known[phase] {
				return LifecycleReliabilityConfiguration{}, fmt.Errorf(
					"%s contains unknown phase %q", lifecyclePhaseDeadlinesEnv, phase)
			}
			deadline, err := time.ParseDuration(value)
			if err != nil || deadline <= 0 {
				return LifecycleReliabilityConfiguration{}, fmt.Errorf(
					"%s phase %q must be a positive duration", lifecyclePhaseDeadlinesEnv, phase)
			}
			configuration.PhaseDeadlines[phase] = deadline
		}
	}
	var err error
	configuration.FailedCreateTTL, err = lifecycleFailedCreateTTL(
		lookup(lifecycleFailedCreateTTLEnv), configuration.FailedCreateTTL)
	if err != nil {
		return LifecycleReliabilityConfiguration{}, err
	}
	configuration.FailedCreateGCInterval, err = positiveDuration(
		lookup(lifecycleGCIntervalEnv), lifecycleGCIntervalEnv, configuration.FailedCreateGCInterval)
	if err != nil {
		return LifecycleReliabilityConfiguration{}, err
	}
	return configuration, nil
}

func lifecycleFailedCreateTTL(raw string, fallback time.Duration) (time.Duration, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fallback, nil
	}
	invalid := fmt.Errorf(
		"%s must be 0, an integer day count, or a positive duration", lifecycleFailedCreateTTLEnv)
	if raw == "0" {
		return 0, nil
	}
	if strings.HasSuffix(raw, "d") {
		days, err := strconv.Atoi(strings.TrimSuffix(raw, "d"))
		if err != nil || days < 0 ||
			int64(days) > (int64(1<<63-1))/int64(24*time.Hour) {
			return 0, invalid
		}
		return time.Duration(days) * 24 * time.Hour, nil
	}
	value, err := time.ParseDuration(raw)
	if err != nil || value < 0 {
		return 0, invalid
	}
	return value, nil
}
