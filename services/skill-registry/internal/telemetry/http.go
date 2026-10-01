package telemetry

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

func HTTPHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := propagation.TraceContext{}.Extract(r.Context(), propagation.HeaderCarrier(r.Header))
		ctx, span := otel.Tracer(instrumentationName+"/http").Start(ctx, "HTTP "+r.Method, trace.WithSpanKind(trace.SpanKindServer))
		request := r.WithContext(ctx)
		observed := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		defer func() {
			panicValue := recover()
			route := strings.TrimSpace(request.Pattern)
			if _, path, ok := strings.Cut(route, " "); ok {
				route = strings.TrimSpace(path)
			}
			if route == "" {
				route = "unmatched"
			}
			status := observed.status
			if panicValue != nil {
				if !observed.wroteHeader {
					status = http.StatusInternalServerError
				}
				span.SetStatus(codes.Error, "handler_panic")
			} else if ctx.Err() != nil {
				markError(span, ctx.Err(), "request_error")
			} else if observed.writeErr != nil {
				markError(span, observed.writeErr, "write_error")
			} else if status >= http.StatusInternalServerError {
				span.SetStatus(codes.Error, strconv.Itoa(status))
			}
			span.SetName("HTTP " + request.Method + " " + route)
			span.SetAttributes(attribute.String("http.request.method", request.Method), attribute.String("http.route", route), attribute.Int("http.response.status_code", status))
			span.End()
			if panicValue != nil {
				panic(panicValue)
			}
		}()
		next.ServeHTTP(observed, request)
	})
}

func markError(span trace.Span, err error, fallback string) {
	kind := fallback
	if errors.Is(err, context.Canceled) {
		kind = "cancelled"
	} else if errors.Is(err, context.DeadlineExceeded) {
		kind = "timeout"
	}
	span.SetAttributes(attribute.String("error.type", kind))
	span.SetStatus(codes.Error, kind)
}

type statusWriter struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
	writeErr    error
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *statusWriter) WriteHeader(status int) {
	if w.wroteHeader {
		return
	}
	if status >= 200 {
		w.status, w.wroteHeader = status, true
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusWriter) Write(body []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	n, err := w.ResponseWriter.Write(body)
	if err != nil {
		w.writeErr = err
	}
	return n, err
}
