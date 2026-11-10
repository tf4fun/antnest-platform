package telemetry

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	semconv "github.com/tf4fun/antnest-platform/libs/go/telemetry"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
)

func HTTPHandler(next http.Handler, logger *slog.Logger) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		ctx, span := semconv.StartServer(request, instrumentationName+"/http", nil)
		outcome := &requestOutcome{}
		ctx = context.WithValue(ctx, requestOutcomeKey{}, outcome)
		instrumented := request.WithContext(ctx)

		requestCapture := &bodyObservation{}
		if instrumented.Body != nil {
			instrumented.Body = semconv.WrapBody(instrumented.Body, semconv.BodyCallbacks{
				Read: func(n int, _ error) { requestCapture.add(n) },
			})
		}

		observed := semconv.NewServerWriter(response, ctx, func(err error) {
			if err != http.ErrNotSupported {
				outcome.set(err)
			}
		})
		started := time.Now()
		span.SetAttributes(semconv.AliasAttributes(attribute.String("http.request.method", request.Method), attribute.String(semconv.AntnestOutcome, "success"))...)

		defer func() {
			panicValue := recover()
			if panicValue != nil {
				outcome.set(fmt.Errorf("handler panic (%T)", panicValue))
			}
			route := normalizedRoute(instrumented.Pattern)
			span.SetName("HTTP " + request.Method + " " + route)
			span.SetAttributes(attribute.String("http.route", route))
			status := observed.Status
			if !observed.WroteHeader && panicValue != nil {
				status = 0
			}
			if status != 0 {
				span.SetAttributes(semconv.AliasAttributes(attribute.Int("http.response.status_code", status))...)
			}

			span.SetAttributes(semconv.AliasAttributes(attribute.Int64("http.request.body.size", requestCapture.size()), attribute.Int64("http.response.body.size", observed.Written))...)

			if err := request.Context().Err(); err != nil {
				outcome.set(err)
			}
			failure := outcome.get()
			if failure != nil {
				recordFailure(span, "handle", failure, status)
			} else if status >= 500 {
				span.SetStatus(codes.Error, "HTTP status "+strconv.Itoa(status))
				span.SetAttributes(semconv.AliasAttributes(attribute.String("error.type", strconv.Itoa(status)), attribute.String(semconv.AntnestOutcome, "failure"))...)
			} else if status >= 400 {
				span.SetAttributes(semconv.AliasAttributes(attribute.String(semconv.AntnestOutcome, "rejected"))...)
			}
			if panicValue != nil {
				span.SetAttributes(attribute.String("error.type", "panic"))
				span.SetStatus(codes.Error, "HTTP handler panicked")
			}
			if route != "/status" || status >= 400 || failure != nil {
				fields := []any{"method", request.Method, "route", route, "status_code", status, "duration_ms", time.Since(started).Milliseconds(), "trace_id", span.SpanContext().TraceID().String(), "span_id", span.SpanContext().SpanID().String()}
				if failure != nil {
					kind, message := errorSummary(failure)
					types, causes := safeCauses(failure)
					fields = append(fields, "error.type", kind, "error.message", message, "error.cause_types", types, "error.causes", causes)
				}
				logger.InfoContext(ctx, "Admin Console request completed", fields...)
			}
			span.End()
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
	if pattern == "" {
		return "unmatched"
	}
	return pattern
}
