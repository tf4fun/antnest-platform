package telemetry

import (
	"bufio"
	"context"
	"fmt"
	"io"
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

func HTTPHandler(next http.Handler, logger *slog.Logger) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		ctx := propagation.TraceContext{}.Extract(request.Context(), propagation.HeaderCarrier(request.Header))
		ctx, span := otel.Tracer(instrumentationName+"/http").Start(ctx, request.Method, trace.WithSpanKind(trace.SpanKindServer))
		outcome := &requestOutcome{}
		ctx = context.WithValue(ctx, requestOutcomeKey{}, outcome)
		instrumented := request.WithContext(ctx)

		requestCapture := &bodyObservation{}
		if instrumented.Body != nil {
			instrumented.Body = &capturedBody{ReadCloser: instrumented.Body, capture: requestCapture}
		}

		observed := &statusWriter{ResponseWriter: response, capture: &bodyObservation{}, outcome: outcome}
		started := time.Now()
		span.SetAttributes(attribute.String("http.request.method", request.Method), attribute.String("antnest.outcome", "success"))

		defer func() {
			panicValue := recover()
			if panicValue != nil {
				outcome.set(fmt.Errorf("handler panic (%T)", panicValue))
			}
			route := normalizedRoute(instrumented.Pattern)
			span.SetName("HTTP " + request.Method + " " + route)
			span.SetAttributes(attribute.String("http.route", route))
			status := observed.status
			if status == 0 && panicValue == nil {
				status = http.StatusOK
			}
			if status != 0 {
				span.SetAttributes(attribute.Int("http.response.status_code", status))
			}

			span.SetAttributes(attribute.Int64("http.request.body.size", requestCapture.size()), attribute.Int64("http.response.body.size", observed.capture.size()))

			if err := request.Context().Err(); err != nil {
				outcome.set(err)
			}
			failure := outcome.get()
			if failure != nil {
				recordFailure(span, "handle", failure, status)
			} else if status >= 500 {
				span.SetStatus(codes.Error, "HTTP status "+strconv.Itoa(status))
				span.SetAttributes(attribute.String("error.type", strconv.Itoa(status)), attribute.String("antnest.outcome", "failure"))
			} else if status >= 400 {
				span.SetAttributes(attribute.String("antnest.outcome", "rejected"))
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

type statusWriter struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
	capture     *bodyObservation
	outcome     *requestOutcome
}

func (writer *statusWriter) Unwrap() http.ResponseWriter { return writer.ResponseWriter }

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
	writer.capture.add(payload[:n])
	writer.outcome.set(err)
	return n, err
}

func (writer *statusWriter) Flush() {
	_ = writer.FlushError()
}

func (writer *statusWriter) FlushError() error {
	if !writer.wroteHeader {
		writer.WriteHeader(http.StatusOK)
	}
	err := http.NewResponseController(writer.ResponseWriter).Flush()
	if err != http.ErrNotSupported {
		writer.outcome.set(err)
	}
	return err
}

func (writer *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return http.NewResponseController(writer.ResponseWriter).Hijack()
}

func (writer *statusWriter) ReadFrom(reader io.Reader) (int64, error) {
	return io.Copy(struct{ io.Writer }{writer}, reader)
}
