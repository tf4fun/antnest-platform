package observation

import "testing"

func TestMonitorReadinessIsSeparateFromJournalAndNotifications(t *testing.T) {
	health := &Health{}
	health.MarkJournal(true)
	health.MarkNotifications(true)
	monitor, ok := any(health).(interface{ MonitorReady() bool })
	if !ok {
		t.Fatal("observation health does not expose background monitor readiness")
	}
	for _, ready := range []bool{false, true, false} {
		health.MarkMonitor(ready)
		if monitor.MonitorReady() != ready {
			t.Fatalf("monitor readiness did not follow MarkMonitor(%t)", ready)
		}
		if err := health.ObservationReady(); err != nil {
			t.Fatalf("monitor state changed journal/notification readiness: %v", err)
		}
	}
	health.MarkMonitor(true)
	health.MarkNotifications(false)
	if !monitor.MonitorReady() || health.ObservationReady() == nil {
		t.Fatal("monitor readiness masked a notification failure")
	}
}
