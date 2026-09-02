package repository

import (
	"testing"
	"time"
)

func TestTokenLastUsedSamplingSkipsFreshRows(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)

	if !shouldTouchTokenLastUsed(nil, now) {
		t.Fatal("a token without last-use telemetry was not sampled")
	}
	fresh := now.Add(-tokenLastUsedSampleWindow + time.Second)
	if shouldTouchTokenLastUsed(&fresh, now) {
		t.Fatal("a token inside the sampling window requested an UPDATE")
	}
	stale := now.Add(-tokenLastUsedSampleWindow - time.Second)
	if !shouldTouchTokenLastUsed(&stale, now) {
		t.Fatal("a stale token did not request a telemetry sample")
	}
}
