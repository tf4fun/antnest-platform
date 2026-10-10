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

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
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
		ctx := otel.GetTextMapPropagator().Extract(
			request.Context(), propagation.HeaderCarrier(request.Header),
		)
		ctx, span := otel.Tracer(instrumentationName+"/http").Start(
			ctx, "HTTP "+request.Method, trace.WithSpanKind(trace.SpanKindServer),
		)
		outcome := &requestOutcome{}
		ctx = context.WithValue(ctx, requestOutcomeKey{}, outcome)
		requestBody := &bodyObservation{}
		started := time.Now()
		observed := &statusWriter{ResponseWriter: response, status: http.StatusOK, capture: &bodyObservation{}}
		if traceID := span.SpanContext().TraceID(); traceID.IsValid() {
			observed.Header().Set("X-Antnest-Trace-ID", traceID.String())
		}
		instrumented := request.WithContext(ctx)
		if instrumented.Body != nil {
			instrumented.Body = &capturedBody{ReadCloser: instrumented.Body, capture: requestBody}
		}
		completed := false
		defer func() {
			failure := recover()
			if failure == http.ErrAbortHandler && instrumented.Context().Err() != nil {
				span.SetAttributes(attribute.Bool("antnest.http.request_cancelled", true))
			}
			span.SetAttributes(attribute.Int64("http.request.body.size", requestBody.observedSize()), attribute.Int64("http.response.body.size", observed.capture.observedSize()))
			requestError := outcome.err
			if requestError == nil {
				requestError = observed.capture.readError()
			}
			if failure != nil {
				span.AddEvent("antnest.error", trace.WithAttributes(attribute.String("antnest.error.stage", "handler"), attribute.String("error.type", "handler_aborted"), attribute.String("antnest.error.panic_type", fmt.Sprintf("%T", failure))))
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
	status := observed.status
	if !completed && !observed.wroteHeader {
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
	http.ResponseWriter
	status      int
	wroteHeader bool
	capture     *bodyObservation
}

func (writer *statusWriter) Unwrap() http.ResponseWriter { return writer.ResponseWriter }

func (writer *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	connection, buffer, err := http.NewResponseController(writer.ResponseWriter).Hijack()
	if err == nil {
		writer.status = http.StatusSwitchingProtocols
		writer.wroteHeader = true
	}
	return connection, buffer, err
}

func (writer *statusWriter) WriteHeader(status int) {
	if writer.wroteHeader {
		return
	}
	if status >= 100 && status < 200 && status != http.StatusSwitchingProtocols {
		writer.ResponseWriter.WriteHeader(status)
		return
	}
	writer.wroteHeader = true
	writer.status = status
	writer.ResponseWriter.WriteHeader(status)
}

func (writer *statusWriter) Write(payload []byte) (int, error) {
	if !writer.wroteHeader {
		writer.WriteHeader(http.StatusOK)
	}
	n, err := writer.ResponseWriter.Write(payload)
	if writer.capture != nil {
		writer.capture.add(payload[:n], err)
	}
	return n, err
}

func (writer *statusWriter) Flush() {
	_ = writer.FlushError()
}

// ResponseController uses FlushError to preserve socket failures through tracing.
func (writer *statusWriter) FlushError() error {
	if !writer.wroteHeader {
		writer.WriteHeader(http.StatusOK)
	}
	err := http.NewResponseController(writer.ResponseWriter).Flush()
	if writer.capture != nil {
		writer.capture.add(nil, err)
	}
	return err
}
