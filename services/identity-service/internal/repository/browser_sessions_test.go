package repository

import (
	"testing"
	"time"
)

func TestBrowserActivityIntervalIsBoundedAndClippedToIdlePolicy(t *testing.T) {
	for _, test := range []struct {
		idle time.Duration
		want int
	}{
		{time.Nanosecond, 1},
		{time.Millisecond, 1},
		{3 * time.Millisecond, 1},
		{6 * time.Millisecond, 2},
		{5 * time.Second, 1666},
		{90 * time.Second, 30000},
		{30 * time.Minute, 30000},
		{time.Duration(1<<63 - 1), 30000},
	} {
		t.Run(test.idle.String(), func(t *testing.T) {
			if got := browserActivityInterval(test.idle); got != test.want {
				t.Fatalf("activity interval = %d, want %d", got, test.want)
			}
		})
	}
}
