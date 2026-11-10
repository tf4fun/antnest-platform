package telemetry

import (
	"bufio"
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	semconv "github.com/tf4fun/antnest-platform/libs/go/telemetry"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

type clientAddressKey struct{}

// WithClientAddress records only the address resolved by Gateway's trust boundary.
func WithClientAddress(ctx context.Context, address string) context.Context {
	return context.WithValue(ctx, clientAddressKey{}, address)
}

func HTTPHandler(next http.Handler, logger *slog.Logger) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		ctx, span := semconv.StartServer(request, instrumentationName+"/http", otel.GetTextMapPropagator())
		outcome := &requestOutcome{}
		ctx = context.WithValue(ctx, requestOutcomeKey{}, outcome)
		requestBody := &bodyObservation{}
		started := time.Now()
		observed := &statusWriter{ServerWriter: semconv.NewServerWriter(response, ctx, nil)}
		if traceID := span.SpanContext().TraceID(); traceID.IsValid() {
			observed.Header().Set("X-Antnest-Trace-ID", traceID.String())
		}
		instrumented := request.WithContext(ctx)
		if instrumented.Body != nil {
			instrumented.Body = semconv.WrapBody(instrumented.Body, semconv.BodyCallbacks{
				Read: func(n int, err error) { requestBody.add(n, err) },
			})
		}
		completed := false
		defer func() {
			failure := recover()
			if failure == http.ErrAbortHandler && instrumented.Context().Err() != nil {
				span.SetAttributes(semconv.AliasAttributes(attribute.Bool(semconv.AntnestHttpRequestCancelled, true))...)
			}
			span.SetAttributes(semconv.AliasAttributes(attribute.Int64("http.request.body.size", requestBody.observedSize()), attribute.Int64("http.response.body.size", observed.Written))...)
			requestError := outcome.err
			if requestError == nil {
				requestError = observed.WriteErr
			}
			if requestError == nil {
				requestError = requestBody.readError()
			}
			if failure != nil {
				span.AddEvent(semconv.AntnestError, trace.WithAttributes(semconv.AliasAttributes(attribute.String(semconv.AntnestErrorStage, "handler"), attribute.String("error.type", "handler_aborted"), attribute.String(semconv.AntnestErrorPanicType, fmt.Sprintf("%T", failure)))...))
			}
			finishHTTPRequest(instrumented, observed, span, logger, started, completed, requestError)
			if failure != nil {
				panic(failure)
			}
		}()
		next.ServeHTTP(observed, instrumented)
		completed = true
	})
}

func finishHTTPRequest(request *http.Request, observed *statusWriter, span trace.Span, logger *slog.Logger, started time.Time, completed bool, err error) {
	defer span.End()
	if address, _ := request.Context().Value(clientAddressKey{}).(string); address != "" && address != "unknown" {
		span.SetAttributes(attribute.String("client.address", address))
		logger = logger.With("client_address", address)
	}
	route := strings.TrimPrefix(request.Pattern, request.Method+" ")
	if route == "" {
		route = "unmatched"
	}
	status := observed.Status
	if !completed && !observed.WroteHeader {
		status = http.StatusInternalServerError
	}
	span.SetName("HTTP " + request.Method + " " + route)
	span.SetAttributes(
		attribute.String("http.request.method", request.Method),
		attribute.String("http.route", route),
		attribute.Int("http.response.status_code", status),
	)
	if !completed {
		span.SetStatus(codes.Error, "handler_aborted")
	} else if status >= http.StatusInternalServerError {
		span.SetStatus(codes.Error, strconv.Itoa(status))
		span.SetAttributes(attribute.String("error.type", strconv.Itoa(status)))
	}
	if err != nil {
		recordFailure(span, "request", err)
		if !completed {
			span.SetStatus(codes.Error, "handler_aborted")
		}
		kind, message := classifyError(err)
		logger.ErrorContext(request.Context(), "Edge Gateway request failed", "error_type", kind,
			"error_message", message, "cause_types", causeTypes(err), "route", route,
			"status_code", status, "duration_ms", time.Since(started).Milliseconds())
		return
	}
	if route != "/status" || status >= http.StatusBadRequest || !completed {
		logger.InfoContext(request.Context(), "Edge Gateway request completed",
			"method", request.Method, "route", route, "status_code", status,
			"handler_completed", completed, "duration_ms", time.Since(started).Milliseconds())
	}
}

type statusWriter struct {
	*semconv.ServerWriter
}

func (writer *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	connection, buffer, err := writer.ServerWriter.Hijack()
	if err == nil {
		writer.Status = http.StatusSwitchingProtocols
		writer.WroteHeader = true
	}
	return connection, buffer, err
}

// ResponseController uses FlushError to preserve socket failures through tracing.
func (writer *statusWriter) FlushError() error {
	return writer.ServerWriter.FlushError()
}
