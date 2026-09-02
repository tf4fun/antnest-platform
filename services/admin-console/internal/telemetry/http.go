package telemetry

import (
	"log/slog"
	"net/http"
	"strconv"
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
		ctx := otel.GetTextMapPropagator().Extract(
			request.Context(), propagation.HeaderCarrier(request.Header),
		)
		ctx, span := otel.Tracer(instrumentationName+"/http").Start(
			ctx, "HTTP "+request.Method, trace.WithSpanKind(trace.SpanKindServer),
		)
		started := time.Now()
		observed := &statusWriter{ResponseWriter: response, status: http.StatusOK}
		instrumented := request.WithContext(ctx)
		next.ServeHTTP(observed, instrumented)
		route := instrumented.Pattern
		if route == "" {
			route = "unmatched"
		}
		span.SetName("HTTP " + request.Method + " " + route)
		span.SetAttributes(
			attribute.String("http.request.method", request.Method),
			attribute.String("http.route", route),
			attribute.Int("http.response.status_code", observed.status),
		)
		if observed.status >= http.StatusInternalServerError {
			span.SetStatus(codes.Error, strconv.Itoa(observed.status))
		}
		span.End()
		if route != "/status" || observed.status >= http.StatusBadRequest {
			logger.InfoContext(ctx, "Admin Console request completed",
				"method", request.Method, "route", route,
				"status_code", observed.status, "duration_ms", time.Since(started).Milliseconds())
		}
	})
}

type statusWriter struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (writer *statusWriter) Unwrap() http.ResponseWriter { return writer.ResponseWriter }

func (writer *statusWriter) WriteHeader(status int) {
	if writer.wroteHeader {
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
	return writer.ResponseWriter.Write(payload)
}

func (writer *statusWriter) Flush() {
	if !writer.wroteHeader {
		writer.WriteHeader(http.StatusOK)
	}
	if flusher, ok := writer.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}
