package main

import (
	"log/slog"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/acpclient"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/config"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/repository/postgres"
)

func configureExecutionPublication(repository *postgres.Repository, cfg config.Config, opener ports.CredentialOpener, runtime ports.RuntimeConnectionResolver, logger *slog.Logger) (*application.ExecutionPublisher, *application.ExecutionPublicationWorker, error) {
	client, err := acpclient.New(cfg.Execution.URL, cfg.DependencyTimeout, cfg.Authentication.HTTPClient())
	if err != nil {
		return nil, nil, err
	}
	capacity, err := application.NewExecutionCapacity(opener, cfg.Execution.MaxBytes, application.WithExecutionCapacityWireVersion(cfg.Execution.WireVersion))
	if err != nil {
		return nil, nil, err
	}
	publisher := application.NewExecutionPublisher(repository, opener, client, application.WithRuntimeConnectionResolver(runtime), application.WithExecutionWireVersion(cfg.Execution.WireVersion))
	worker, err := application.NewExecutionPublicationWorker(repository, publisher, application.ExecutionPublicationSchedule{
		ResyncInterval: cfg.Execution.ResyncInterval, RetryInterval: cfg.Execution.RetryInterval,
		MaxRetryInterval: cfg.Execution.MaxRetryInterval, RequestTimeout: cfg.Execution.RequestTimeout,
	}, logger)
	if err != nil {
		return nil, nil, err
	}
	// Composition finishes before any configuration writer or worker starts.
	postgres.WithExecutionCapacityGuard(capacity)(repository)
	postgres.WithExecutionChangeObserver(worker.Notify)(repository)
	return publisher, worker, nil
}
