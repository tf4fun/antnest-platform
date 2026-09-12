package postgres

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

const agentEventNotificationChannel = "agent_controller_events"

var errEventNotifierClosed = errors.New("agent event notifier is closed")

type EventNotifierObserver func(string)

type EventNotifierOption func(*EventNotifier)

func WithEventNotifierObserver(observer EventNotifierObserver) EventNotifierOption {
	return func(notifier *EventNotifier) { notifier.observer = observer }
}

// EventNotifier owns one PostgreSQL LISTEN connection and fans commit hints out
// to every local watcher. Journal replay remains authoritative.
type EventNotifier struct {
	ctx      context.Context
	cancel   context.CancelFunc
	config   *pgx.ConnConfig
	observer EventNotifierObserver

	mu     sync.Mutex
	signal chan struct{}
	closed bool
	once   sync.Once
	wait   sync.WaitGroup
}

func OpenEventNotifier(
	ctx context.Context, databaseURL string, options ...EventNotifierOption,
) (*EventNotifier, error) {
	poolConfig, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse Agent event notifier database URL: %w", err)
	}
	poolConfig.ConnConfig.Tracer = newDatabaseTracer()
	connection, err := connectEventListener(ctx, poolConfig.ConnConfig.Copy())
	if err != nil {
		return nil, err
	}
	lifetime, cancel := context.WithCancel(context.Background())
	notifier := &EventNotifier{
		ctx: lifetime, cancel: cancel, config: poolConfig.ConnConfig.Copy(), signal: make(chan struct{}),
	}
	for _, option := range options {
		if option != nil {
			option(notifier)
		}
	}
	notifier.wait.Add(1)
	go notifier.run(connection)
	return notifier, nil
}

func (notifier *EventNotifier) SubscribeAgentEvents() (<-chan struct{}, error) {
	notifier.mu.Lock()
	defer notifier.mu.Unlock()
	if notifier.closed {
		return nil, errEventNotifierClosed
	}
	return notifier.signal, nil
}

func (notifier *EventNotifier) Close() {
	if notifier == nil {
		return
	}
	notifier.once.Do(func() {
		notifier.cancel()
		notifier.wait.Wait()
	})
}

func (notifier *EventNotifier) run(connection *pgx.Conn) {
	defer notifier.wait.Done()
	defer notifier.finish()
	current := connection
	for {
		_, err := current.WaitForNotification(notifier.ctx)
		if err == nil {
			notifier.broadcast()
			continue
		}
		closeEventListener(current)
		if notifier.ctx.Err() != nil {
			return
		}
		notifier.observe("disconnected")
		notifier.broadcast()
		current = notifier.reconnect()
		if current == nil {
			return
		}
		// A notification may have committed while the listener was disconnected.
		notifier.observe("reconnected")
		notifier.broadcast()
	}
}

func (notifier *EventNotifier) reconnect() *pgx.Conn {
	delay := 100 * time.Millisecond
	for {
		timer := time.NewTimer(delay)
		select {
		case <-notifier.ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
		connection, err := connectEventListener(notifier.ctx, notifier.config.Copy())
		if err == nil {
			return connection
		}
		if delay < 5*time.Second {
			delay *= 2
			if delay > 5*time.Second {
				delay = 5 * time.Second
			}
		}
	}
}

func (notifier *EventNotifier) broadcast() {
	notifier.mu.Lock()
	defer notifier.mu.Unlock()
	if notifier.closed {
		return
	}
	close(notifier.signal)
	notifier.signal = make(chan struct{})
}

func (notifier *EventNotifier) finish() {
	notifier.mu.Lock()
	defer notifier.mu.Unlock()
	if notifier.closed {
		return
	}
	notifier.closed = true
	close(notifier.signal)
}

func (notifier *EventNotifier) observe(state string) {
	if notifier.observer != nil {
		notifier.observer(state)
	}
}

func connectEventListener(ctx context.Context, config *pgx.ConnConfig) (*pgx.Conn, error) {
	connection, err := pgx.ConnectConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("connect Agent event listener: %w", err)
	}
	if _, err := connection.Exec(ctx, "LISTEN "+agentEventNotificationChannel); err != nil {
		closeEventListener(connection)
		return nil, fmt.Errorf("listen for Agent events: %w", err)
	}
	return connection, nil
}

func closeEventListener(connection *pgx.Conn) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = connection.Close(ctx)
}

var _ ports.AgentEventNotifier = (*EventNotifier)(nil)
