package config

import (
	"testing"
	"time"
)

func TestResolveCacheConfigurationDefaultsAndBounds(t *testing.T) {
	for _, fixture := range []struct {
		name, ttl, size string
		wantTTL         time.Duration
		wantSize        int
		valid           bool
	}{
		{"defaults", "", "", 10 * time.Second, 50000, true},
		{"disabled", "0", "1", 0, 1, true},
		{"maximum", "30s", "50000", 30 * time.Second, 50000, true},
		{"subsecond", "250ms", "42", 250 * time.Millisecond, 42, true},
		{"trimmed", " 1s ", " 10 ", time.Second, 10, true},
		{"negative TTL", "-1ns", "", 0, 0, false},
		{"TTL above maximum", "30.000000001s", "", 0, 0, false},
		{"malformed TTL", "one", "", 0, 0, false},
		{"unitless TTL", "10", "", 0, 0, false},
		{"zero size", "", "0", 0, 0, false},
		{"negative size", "", "-1", 0, 0, false},
		{"size above maximum", "", "50001", 0, 0, false},
		{"malformed size", "", "1.5", 0, 0, false},
		{"disabled still validates size", "0s", "50001", 0, 0, false},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			values := publicEntryEnvironment()
			values["ANTNEST_EDGE_RESOLVE_CACHE_TTL"] = fixture.ttl
			values["ANTNEST_EDGE_RESOLVE_CACHE_SIZE"] = fixture.size
			cfg, err := Load(func(key string) string { return values[key] })
			if !fixture.valid {
				if err == nil {
					t.Fatal("out-of-policy cache configuration accepted")
				}
				return
			}
			if err != nil || cfg.ResolveCacheTTL != fixture.wantTTL || cfg.ResolveCacheSize != fixture.wantSize {
				t.Fatalf("cache configuration TTL=%v size=%d err=%v", cfg.ResolveCacheTTL, cfg.ResolveCacheSize, err)
			}
		})
	}
}
