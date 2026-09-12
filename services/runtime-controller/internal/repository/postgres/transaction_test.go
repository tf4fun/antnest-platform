package postgres

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/trace"
)

type rollbackProbe struct {
	driver.Conn
	entered  chan struct{}
	proceed  chan struct{}
	finished chan struct{}
}

func (p *rollbackProbe) Connect(context.Context) (driver.Conn, error) { return p, nil }
func (p *rollbackProbe) Driver() driver.Driver                        { return nil }
func (p *rollbackProbe) Close() error                                 { return nil }
func (p *rollbackProbe) Begin() (driver.Tx, error) {
	return p.BeginTx(context.Background(), driver.TxOptions{})
}
func (p *rollbackProbe) BeginTx(ctx context.Context, _ driver.TxOptions) (driver.Tx, error) {
	_, span := otel.Tracer("runtime_controller.database").Start(ctx, "postgresql transaction")
	return &transactionDriver{inner: p, span: span, release: func() { close(p.finished) }}, nil
}
func (p *rollbackProbe) Commit() error { return nil }
func (p *rollbackProbe) Rollback() error {
	close(p.entered)
	<-p.proceed
	return nil
}

func TestTransactionSpanWaitsForAutomaticRollback(t *testing.T) {
	for _, cleanup := range []string{"none", "rollback", "commit"} {
		t.Run(cleanup, func(t *testing.T) {
			recorder := recordDatabaseSpans(t)
			probe := &rollbackProbe{entered: make(chan struct{}), proceed: make(chan struct{}), finished: make(chan struct{})}
			db := sql.OpenDB(probe)
			defer func() {
				if err := db.Close(); err != nil {
					t.Error(err)
				}
			}()
			ctx, parent := otel.Tracer("test").Start(t.Context(), "request", trace.WithSpanKind(trace.SpanKindServer))
			defer parent.End()
			ctx, cancel := context.WithCancel(ctx)
			defer cancel()
			tx, err := db.BeginTx(ctx, nil)
			if err != nil {
				t.Fatal(err)
			}
			cancel()
			// Unblock the native rollback even when an assertion fails.
			defer close(probe.proceed)
			select {
			case <-probe.entered:
			case <-time.After(time.Second):
				t.Fatal("database/sql did not initiate rollback")
			}
			switch cleanup {
			case "rollback":
				err = tx.Rollback()
			case "commit":
				err = tx.Commit()
			}
			if cleanup != "none" && !errors.Is(err, sql.ErrTxDone) && !errors.Is(err, context.Canceled) {
				t.Fatalf("cleanup result changed: %v", err)
			}
			if len(recorder.Ended()) != 0 {
				t.Fatal("transaction span ended before native rollback completed")
			}
			// The nested scope closes proceed before waiting for the completion below.
			t.Cleanup(func() {
				select {
				case <-probe.finished:
				case <-time.After(time.Second):
					t.Error("automatic rollback left an unfinished span")
					return
				}
				count := 0
				for _, span := range recorder.Ended() {
					if span.Name() == "postgresql transaction" {
						count++
						if !span.Parent().Equal(parent.SpanContext()) {
							t.Error("rollback lost transaction parent")
						}
					}
				}
				if count != 1 {
					t.Errorf("transaction span count = %d", count)
				}
			})
		})
	}
}
