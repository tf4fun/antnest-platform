package telemetry

import "sync"

// bodyObservation counts bytes consumed by the existing transport without retaining contents.
type bodyObservation struct {
	mu       sync.Mutex
	observed int64
}

func (c *bodyObservation) add(data []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.observed += int64(len(data))
}

func (c *bodyObservation) size() int64 { c.mu.Lock(); defer c.mu.Unlock(); return c.observed }
