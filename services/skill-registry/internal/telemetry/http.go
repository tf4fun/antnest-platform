package telemetry

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"

	semconv "github.com/tf4fun/antnest-platform/libs/go/telemetry"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

func HTTPHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, span := semconv.StartServer(r, instrumentationName+"/http", nil)
		request := r.WithContext(ctx)
		observed := semconv.NewServerWriter(w, ctx, nil)
		defer func() {
			panicValue := recover()
			route := strings.TrimSpace(request.Pattern)
			if _, path, ok := strings.Cut(route, " "); ok {
				route = strings.TrimSpace(path)
			}
			if route == "" {
				route = "unmatched"
			}
			status := observed.Status
			if panicValue != nil {
				if !observed.WroteHeader {
					status = http.StatusInternalServerError
				}
				span.SetStatus(codes.Error, "handler_panic")
			} else if ctx.Err() != nil {
				markError(span, ctx.Err(), "request_error")
			} else if observed.WriteErr != nil {
				markError(span, observed.WriteErr, "write_error")
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
