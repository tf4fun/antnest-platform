package server

import (
	"context"

	semconv "github.com/tf4fun/antnest-platform/libs/go/telemetry"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

func newLoginAdmissionRecorder() (func(loginAdmissionFlow, loginAdmissionOutcome), error) {
	counter, err := otel.Meter("antnest.edge-gateway.login-admission").Int64Counter(
		semconv.AntnestEdgeLoginAdmissionTotal,
		metric.WithDescription("Gateway login admission decisions"),
		metric.WithUnit("{request}"),
	)
	if err != nil {
		return nil, err
	}
	return func(flow loginAdmissionFlow, outcome loginAdmissionOutcome) {
		counter.Add(context.Background(), 1, metric.WithAttributes(semconv.MetricAttributes(attribute.String("flow", string(flow)), attribute.String("outcome", string(outcome)))...))
	}, nil
}
