package telemetry

import (
	"io"
	"sync"
)

// bodyObservation counts only bytes consumed by the existing transport.
type bodyObservation struct {
	mu       sync.Mutex
	observed int64
	err      error
}

func (c *bodyObservation) readError() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

func (c *bodyObservation) add(data []byte, err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.observed += int64(len(data))
	if err != nil && err != io.EOF {
		c.err = err
	}
}
