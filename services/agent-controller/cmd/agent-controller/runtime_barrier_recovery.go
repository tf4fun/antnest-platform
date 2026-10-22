package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/acpclient"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/config"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/repository/postgres"
)

type controllerBackgroundWorker struct {
	name string
	run  func(context.Context)
}

type controllerHTTPServer interface {
	Serve(net.Listener) error
	Shutdown(context.Context) error
	Close() error
}

func configureRuntimeBarrierRecovery(repository *postgres.Repository, cfg config.Config, lifecycle *application.LifecycleService,
	starter application.RuntimeBarrierRecoveryStarter, logger *slog.Logger,
) (*application.RuntimeBarrierRecoveryObservationWorker, *application.RuntimeBarrierRecoveryStartWorker, error) {
	reader, err := acpclient.New(cfg.Execution.URL, cfg.DependencyTimeout, cfg.Authentication.HTTPClient())
	if err != nil {
		return nil, nil, err
	}
	schedule := cfg.RuntimeBarrierRecovery
	observation, err := application.NewRuntimeBarrierRecoveryObservationWorker(repository, reader,
		application.NewRuntimeBarrierRecoveryAdmissionService(lifecycle, repository),
		application.RuntimeBarrierRecoveryObservationSchedule{PollInterval: schedule.PollInterval,
			RoundTimeout: schedule.RoundTimeout, BatchSize: schedule.BatchSize}, logger)
	if err != nil {
		return nil, nil, err
	}
	start, err := application.NewRuntimeBarrierRecoveryStartWorker(repository, starter,
		application.RuntimeBarrierRecoveryStartSchedule{PollInterval: schedule.PollInterval,
			RoundTimeout: schedule.RoundTimeout, BatchSize: schedule.BatchSize}, logger)
	if err != nil {
		return nil, nil, err
	}
	return observation, start, nil
}

// All dependencies and the listener have been constructed before entering this
// owner. Publication, observation and durable start recovery run independently.
// Returning transfers ownership back to main, whose defers may close Temporal
// and PostgreSQL only after every actual callback below has returned.
func serveController(ctx context.Context, server controllerHTTPServer, listener net.Listener,
	shutdownTimeout time.Duration, workers ...controllerBackgroundWorker,
) error {
	if ctx.Err() != nil {
		if listener != nil {
			return classifyFailure("listener_close", listener.Close())
		}
		return nil
	}
	workerCtx, cancelWorkers := context.WithCancel(ctx)
	defer cancelWorkers()
	serveStopped := make(chan struct{})
	var serveErr error
	go func() {
		defer close(serveStopped)
		serveErr = server.Serve(listener)
	}()
	stopped := make([]chan struct{}, len(workers))
	for index, worker := range workers {
		done := make(chan struct{})
		stopped[index] = done
		go func() {
			defer close(done)
			if workerCtx.Err() == nil {
				worker.run(workerCtx)
			}
		}()
	}
	select {
	case <-ctx.Done():
	case <-serveStopped:
	}
	cancelWorkers()
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancelShutdown()
	failure := shutdownHTTP(shutdownCtx, server)
	for index, worker := range workers {
		failure = errors.Join(failure, joinControllerOwner(shutdownCtx, stopped[index], worker.name+"_shutdown"))
	}
	failure = errors.Join(failure, joinControllerOwner(shutdownCtx, serveStopped, "http_serve_shutdown"))
	if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
		failure = errors.Join(classifyFailure("http_serve", serveErr), failure)
	}
	return failure
}

func joinControllerOwner(ctx context.Context, stopped <-chan struct{}, failureClass string) error {
	select {
	case <-stopped:
		return nil
	default:
	}
	select {
	case <-stopped:
		return nil
	case <-ctx.Done():
		failure := classifyFailure(failureClass, ctx.Err())
		// A deadline records a shutdown failure, not an actual join. Preserve
		// dependencies until the original operation has really stopped.
		<-stopped
		return failure
	}
}
