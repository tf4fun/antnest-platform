package config

import (
	"strings"
	"testing"
	"time"
)

func TestObservationPruningConfiguration(t *testing.T) {
	for _, test := range []struct {
		name, rows, interval string
		wantRows             int64
		wantInterval         time.Duration
		bad                  string
	}{
		{name: "defaults", wantRows: 1_000_000, wantInterval: time.Minute},
		{name: "explicit", rows: "25", interval: "3s", wantRows: 25, wantInterval: 3 * time.Second},
		{name: "zero rows", rows: "0", bad: "ANTNEST_OBSERVATION_MAX_ROWS"},
		{name: "negative rows", rows: "-1", bad: "ANTNEST_OBSERVATION_MAX_ROWS"},
		{name: "fractional rows", rows: "1.5", bad: "ANTNEST_OBSERVATION_MAX_ROWS"},
		{name: "overflow rows", rows: "9223372036854775808", bad: "ANTNEST_OBSERVATION_MAX_ROWS"},
		{name: "invalid interval", interval: "soon", bad: "ANTNEST_OBSERVATION_PRUNE_INTERVAL"},
		{name: "zero interval", interval: "0s", bad: "ANTNEST_OBSERVATION_PRUNE_INTERVAL"},
		{name: "negative interval", interval: "-1s", bad: "ANTNEST_OBSERVATION_PRUNE_INTERVAL"},
	} {
		t.Run(test.name, func(t *testing.T) {
			values := map[string]string{
				"ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL": "postgres://runtime:runtime@postgres/runtime",
				"ANTNEST_RUNTIME_MANAGEMENT_NETWORK":      "antnest-runtime-management",
			}
			if test.rows != "" {
				values["ANTNEST_OBSERVATION_MAX_ROWS"] = test.rows
			}
			if test.interval != "" {
				values["ANTNEST_OBSERVATION_PRUNE_INTERVAL"] = test.interval
			}
			got, err := Load(testEnvironment(t, values))
			if test.bad != "" {
				if err == nil || !strings.Contains(err.Error(), test.bad) {
					t.Fatalf("invalid configuration accepted: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got.ObservationMaxRows != test.wantRows || got.ObservationPruneInterval != test.wantInterval {
				t.Fatalf("pruning configuration = rows %d interval %s", got.ObservationMaxRows, got.ObservationPruneInterval)
			}
		})
	}
}
