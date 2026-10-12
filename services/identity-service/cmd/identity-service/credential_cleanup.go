package main

import (
	"context"
	"log/slog"
	"time"
)

func startCredentialCleanup(parent context.Context, cleanup func(context.Context) (int64, error), logger *slog.Logger) func() {
	ctx, cancel := context.WithCancel(parent)
	done := make(chan struct{})
	go func() {
		defer close(done)
		timer := time.NewTimer(time.Minute)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
			}
			if ctx.Err() != nil {
				return
			}
			_, err := cleanup(ctx)
			if ctx.Err() != nil {
				return
			}
			if err != nil {
				logger.Warn("Identity credential attempt cleanup failed", "error_class", "credential_cleanup_failure")
			}
			timer.Reset(time.Minute)
		}
	}()
	return func() {
		cancel()
		<-done
	}
}
