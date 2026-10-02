package observation

import (
	"fmt"
	"sync/atomic"
)

type Health struct {
	journal       atomic.Bool
	monitor       atomic.Bool
	notifications atomic.Bool
}

func (h *Health) MarkJournal(healthy bool) {
	h.journal.Store(healthy)
}

func (h *Health) MarkMonitor(healthy bool) {
	h.monitor.Store(healthy)
}

func (h *Health) MonitorReady() bool {
	return h.monitor.Load()
}

func (h *Health) MarkNotifications(healthy bool) {
	h.notifications.Store(healthy)
}

func (h *Health) ObservationReady() error {
	if !h.journal.Load() {
		return fmt.Errorf("observation journal write path is not ready")
	}
	if !h.notifications.Load() {
		return fmt.Errorf("cross-replica observation notifications are not ready")
	}
	return nil
}
