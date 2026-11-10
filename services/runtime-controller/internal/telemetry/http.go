package telemetry

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	semconv "github.com/tf4fun/antnest-platform/libs/go/telemetry"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

var (
	httpTracer   = otel.Tracer(instrumentationName)
	httpMeter    = otel.Meter(instrumentationName)
	httpRequests = mustCounter(httpMeter.Int64Counter("http.server.requests"))
	httpDuration = mustHistogram(httpMeter.Float64Histogram("http.server.request.duration", metric.WithUnit("s")))
)

func HTTPHandler(next http.Handler) http.Handler {
	captureRPC := strings.EqualFold(strings.TrimSpace(os.Getenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT")), "true")
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		ctx, span := semconv.StartServerWithTracer(request, httpTracer, nil)
		started := time.Now()
		state := &httpObservation{span: span, captureRPC: captureRPC}
		ctx = context.WithValue(ctx, observationKey{}, state)
		observed := &statusWriter{observation: state}
		observed.ServerWriter = semconv.NewServerWriter(response, ctx, nil)
		instrumented := request.WithContext(ctx)
		if instrumented.Body != nil {
			instrumented.Body = semconv.WrapBody(instrumented.Body, semconv.BodyCallbacks{
				Read: func(n int, _ error) { state.requestBytes += int64(n) },
			})
		}

		setDeadline(span, ctx)
		defer func() {
			panicValue := recover()
			if panicValue != nil && !observed.WroteHeader {
				observed.Status = 0
			}
			route := normalizedRoute(instrumented.Pattern)
			span.SetName("HTTP " + request.Method + " " + route)

			attributes := []attribute.KeyValue{attribute.String("http.request.method", request.Method), attribute.String("http.route", route)}
			if observed.Status != 0 {
				attributes = append(attributes, attribute.Int("http.response.status_code", observed.Status))
			}
			span.SetAttributes(semconv.AliasAttributes(attributes...)...)

			span.SetAttributes(semconv.AliasAttributes(attribute.Int64("http.request.body.size", state.requestBytes), attribute.Int64("http.response.body.size", observed.Written))...)

			switch {
			case panicValue != nil:
				RecordFailure(ctx, span, fmt.Errorf("panic value of type %T", panicValue), "handler", "panic", "HTTP handler panicked")
			case observed.WriteErr != nil:
				RecordFailure(ctx, span, observed.WriteErr, "response_write", "response_write_failed", "HTTP response delivery failed")
			case ctx.Err() != nil:
				RecordFailure(ctx, span, ctx.Err(), "handler", "request_canceled", "HTTP request ended by cancellation")
			case observed.Status >= 500 && !state.failed:
				RecordFailure(ctx, span, nil, "handler", strconv.Itoa(observed.Status), "HTTP server returned an error")
			case !state.failed && state.outcome == "":
				outcome := "completed"
				if observed.Status >= 400 {
					outcome = "rejected"
				}
				span.SetAttributes(semconv.AliasAttributes(attribute.String(semconv.AntnestOutcome, outcome))...)
			}
			span.End()
			httpRequests.Add(ctx, 1, metric.WithAttributes(semconv.MetricAttributes(attributes...)...))
			httpDuration.Record(ctx, time.Since(started).Seconds(), metric.WithAttributes(semconv.MetricAttributes(attributes...)...))
			if panicValue != nil {
				panic(panicValue)
			}
		}()
		next.ServeHTTP(observed, instrumented)
	})
}

func normalizedRoute(pattern string) string {
	if _, route, found := strings.Cut(pattern, " "); found {
		pattern = route
	}
	if pattern == "" || pattern == "/" {
		return "unmatched"
	}
	return pattern
}

type statusWriter struct {
	*semconv.ServerWriter
	observation *httpObservation
}

func mustCounter(instrument metric.Int64Counter, err error) metric.Int64Counter {
	if err != nil {
		panic(err)
	}
	return instrument
}

func mustHistogram(instrument metric.Float64Histogram, err error) metric.Float64Histogram {
	if err != nil {
		panic(err)
	}
	return instrument
}
