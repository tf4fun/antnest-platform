package config

import (
	"testing"
	"time"
)

func TestLoadBrowserSessionDurations(t *testing.T) {
	tests := []struct {
		name         string
		idle         string
		absolute     string
		legacy       string
		wantIdle     time.Duration
		wantAbsolute time.Duration
		wantErr      bool
	}{
		{name: "defaults", wantIdle: 30 * time.Minute, wantAbsolute: 12 * time.Hour},
		{name: "explicit idle", idle: "5s", wantIdle: 5 * time.Second, wantAbsolute: 12 * time.Hour},
		{name: "explicit absolute", absolute: "2h", wantIdle: 30 * time.Minute, wantAbsolute: 2 * time.Hour},
		{name: "legacy absolute", legacy: "2h", wantIdle: 30 * time.Minute, wantAbsolute: 2 * time.Hour},
		{name: "equivalent absolute aliases", absolute: "2h", legacy: "120m", wantIdle: 30 * time.Minute, wantAbsolute: 2 * time.Hour},
		{name: "conflicting absolute aliases", absolute: "2h", legacy: "3h", wantErr: true},
		{name: "idle exceeds absolute", idle: "4h", absolute: "2h", wantIdle: 4 * time.Hour, wantAbsolute: 2 * time.Hour},
		{name: "millisecond idle", idle: "1ms", wantIdle: time.Millisecond, wantAbsolute: 12 * time.Hour},
		{name: "zero idle", idle: "0", wantErr: true},
		{name: "negative idle", idle: "-1s", wantErr: true},
		{name: "invalid idle", idle: "nonsense", wantErr: true},
		{name: "zero absolute", absolute: "0", wantErr: true},
		{name: "negative absolute", absolute: "-1s", wantErr: true},
		{name: "invalid absolute", absolute: "nonsense", wantErr: true},
		{name: "zero legacy", legacy: "0", wantErr: true},
		{name: "negative legacy", legacy: "-1s", wantErr: true},
		{name: "invalid legacy", legacy: "nonsense", wantErr: true},
		{name: "invalid legacy with explicit absolute", absolute: "2h", legacy: "nonsense", wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			values := validEnvironment()
			values["ANTNEST_IDENTITY_SESSION_IDLE_TTL"] = test.idle
			values["ANTNEST_IDENTITY_SESSION_ABSOLUTE_TTL"] = test.absolute
			values["ANTNEST_IDENTITY_TOKEN_TTL"] = test.legacy
			config, err := Load(func(key string) string { return values[key] })
			if test.wantErr {
				if err == nil {
					t.Fatal("invalid browser session durations accepted")
				}
				return
			}
			if err != nil {
				t.Fatalf("load browser session durations: %v", err)
			}
			if config.SessionIdleTTL != test.wantIdle {
				t.Errorf("idle duration = %s, want %s", config.SessionIdleTTL, test.wantIdle)
			}
			if config.SessionAbsoluteTTL != test.wantAbsolute {
				t.Errorf("absolute duration = %s, want %s", config.SessionAbsoluteTTL, test.wantAbsolute)
			}
		})
	}
}
