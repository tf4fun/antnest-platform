// Command acp-rpc-timing observes the real Controller client against a separate
// Node process. It is a test fixture, not a production service or timing waiver.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"strconv"
	"sync"
	"syscall"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
	collector "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/acpclient"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

var origin = time.Now()

type clockReading struct {
	Before string `json:"monotonic_before_ns"`
	Wall   string `json:"unix_ns"`
	After  string `json:"monotonic_after_ns"`
}

func clock() clockReading {
	before := time.Since(origin).Nanoseconds()
	wall := time.Now().UnixNano()
	after := time.Since(origin).Nanoseconds()
	return clockReading{strconv.FormatInt(before, 10), strconv.FormatInt(wall, 10), strconv.FormatInt(after, 10)}
}

type observer struct {
	sync.Mutex
	events, spans, exports []map[string]any
}

func (o *observer) event(kind string, span trace.SpanContext) {
	reading := clock()
	o.Lock()
	defer o.Unlock()
	o.events = append(o.events, map[string]any{"kind": kind, "clock": reading, "trace_id": span.TraceID().String(), "span_id": span.SpanID().String()})
}

func (*observer) OnStart(context.Context, sdktrace.ReadWriteSpan) {}
func (o *observer) OnEnd(span sdktrace.ReadOnlySpan) {
	reading := clock()
	o.Lock()
	defer o.Unlock()
	attrs := map[string]any{}
	for _, field := range span.Attributes() {
		attrs[string(field.Key)] = field.Value.AsInterface()
	}
	o.spans = append(o.spans, map[string]any{
		"clock": reading, "trace_id": span.SpanContext().TraceID().String(), "span_id": span.SpanContext().SpanID().String(),
		"start_unix_ns": strconv.FormatInt(span.StartTime().UnixNano(), 10), "end_unix_ns": strconv.FormatInt(span.EndTime().UnixNano(), 10),
		"attributes": attrs, "status": span.Status(),
	})
}
func (*observer) Shutdown(context.Context) error   { return nil }
func (*observer) ForceFlush(context.Context) error { return nil }

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type observedBody struct {
	io.ReadCloser
	observer *observer
	span     trace.SpanContext
	eof      sync.Once
}

func (b *observedBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if errors.Is(err, io.EOF) {
		b.eof.Do(func() { b.observer.event("body_eof", b.span) })
	}
	return n, err
}
func (b *observedBody) Close() error {
	b.observer.event("body_close_enter", b.span)
	err := b.ReadCloser.Close()
	b.observer.event("body_close_return", b.span)
	return err
}

func calibration(ctx context.Context, client *http.Client, endpoint string) (map[string]any, error) {
	record := map[string]any{}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint+"/diagnostic/clock", nil)
	if err != nil {
		return record, err
	}
	record["local_send"] = clock()
	response, err := client.Do(request)
	if err != nil {
		record["local_failed"] = clock()
		return record, err
	}
	body, readErr := io.ReadAll(response.Body)
	closeErr := response.Body.Close()
	record["local_receive"] = clock()
	record["status_code"] = response.StatusCode
	record["response_body_base64"] = body
	if err := errors.Join(readErr, closeErr); err != nil {
		return record, err
	}
	var remote map[string]any
	if response.StatusCode != 200 {
		return record, fmt.Errorf("clock response: HTTP %d", response.StatusCode)
	}
	if err := json.Unmarshal(body, &remote); err != nil {
		return record, err
	}
	record["remote"] = remote
	return record, nil
}

func calibrationPhase(ctx context.Context, client *http.Client, endpoint, phase string, index int) ([]map[string]any, error) {
	var observations []map[string]any
	for sequence := 0; sequence < 5; sequence++ {
		record, err := calibration(ctx, client, endpoint)
		record["rpc_index"], record["phase"], record["sequence"] = index, phase, sequence
		observations = append(observations, record)
		if err != nil {
			record["failure"] = err.Error()
			return observations, err
		}
	}
	return observations, nil
}

func run() (resultErr error) {
	if len(os.Args) != 4 {
		return errors.New("expected endpoint, private output file, sample count")
	}
	endpoint, output := os.Args[1], os.Args[2]
	count, err := strconv.Atoi(os.Args[3])
	if err != nil || count < 1 || count > 1000 {
		return errors.New("invalid sample count")
	}
	signalContext, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	host, err := os.Hostname()
	if err != nil {
		return err
	}
	o := &observer{}
	base := http.DefaultTransport.(*http.Transport).Clone()
	defer base.CloseIdleConnections()
	var samples []map[string]any
	var provider *sdktrace.TracerProvider
	defer func() {
		if provider != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			resultErr = errors.Join(resultErr, provider.ForceFlush(ctx), provider.Shutdown(ctx))
			cancel()
		}
		o.Lock()
		defer o.Unlock()
		report := map[string]any{"host": host, "pid": os.Getpid(), "runtime": runtime.Version(), "os": runtime.GOOS, "wall_clock_resolution_ns": nil,
			"requested_samples": count, "calibrations_per_phase": 5, "samples": samples, "events": o.events, "spans": o.spans, "otlp_exports": o.exports}
		if resultErr != nil {
			report["failure"] = resultErr.Error()
		}
		body, err := json.Marshal(report)
		if err == nil {
			var file *os.File
			file, err = os.OpenFile(output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
			if err == nil {
				_, writeErr := file.Write(append(body, '\n'))
				err = errors.Join(writeErr, file.Close())
			}
		}
		resultErr = errors.Join(resultErr, err)
	}()
	exportHTTP := &http.Client{Timeout: 3 * time.Second, Transport: transportFunc(func(request *http.Request) (*http.Response, error) {
		body, err := io.ReadAll(request.Body)
		closeErr := request.Body.Close()
		if err := errors.Join(err, closeErr); err != nil {
			return nil, err
		}
		request.Body = io.NopCloser(bytes.NewReader(body))
		var decoded collector.ExportTraceServiceRequest
		if err := proto.Unmarshal(body, &decoded); err != nil {
			return nil, err
		}
		jsonBody, err := protojson.Marshal(&decoded)
		if err != nil {
			return nil, err
		}
		o.Lock()
		o.exports = append(o.exports, map[string]any{"body_base64": body, "decoded_otlp": json.RawMessage(jsonBody)})
		o.Unlock()
		return base.RoundTrip(request)
	})}
	exporter, err := otlptracehttp.New(context.Background(), otlptracehttp.WithEndpointURL(endpoint+"/v1/traces"), otlptracehttp.WithHTTPClient(exportHTTP))
	if err != nil {
		return err
	}
	provider = sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(o), sdktrace.WithBatcher(exporter), sdktrace.WithResource(resource.NewSchemaless(
		attribute.String("service.name", "controller-rpc-timing-diagnostic"), attribute.String("host.name", host), attribute.Int("process.pid", os.Getpid()),
		attribute.String("service.instance.id", fmt.Sprintf("%s:%d:%d", host, os.Getpid(), origin.UnixNano())), attribute.String("process.runtime.name", "go"),
	)))
	otel.SetTracerProvider(provider)
	client, err := acpclient.New(endpoint, 5*time.Second, &http.Client{Transport: transportFunc(func(request *http.Request) (*http.Response, error) {
		span := trace.SpanContextFromContext(request.Context())
		o.event("request_send", span)
		response, err := base.RoundTrip(request)
		if err == nil {
			response.Body = &observedBody{ReadCloser: response.Body, observer: o, span: span}
		}
		return response, err
	})})
	if err != nil {
		return err
	}
	clockClient := &http.Client{Transport: base, Timeout: 3 * time.Second}
	ctx, cancel := context.WithTimeout(signalContext, 30*time.Second)
	defer cancel()
	for index := 0; index < count; index++ {
		sample := map[string]any{"index": index, "phase": "before", "complete": false}
		samples = append(samples, sample)
		before, err := calibrationPhase(ctx, clockClient, endpoint, "before", index)
		sample["before"] = before
		if err != nil {
			sample["failure"] = err.Error()
			return err
		}
		sample["phase"] = "rpc"
		result, err := client.ApplyExecutionSnapshot(ctx, ports.ExecutionSnapshot{OrganizationID: "diagnostic-org", Revision: int64(index + 1), Providers: []ports.ExecutionProvider{}, Models: []ports.ExecutionModel{}, Agents: []ports.ExecutionAgent{}})
		sample["call_returned"] = clock()
		if err != nil {
			sample["failure"] = err.Error()
			return err
		}
		sample["result"] = result
		sample["phase"] = "after"
		after, err := calibrationPhase(ctx, clockClient, endpoint, "after", index)
		sample["after"] = after
		if err != nil {
			sample["failure"] = err.Error()
			return err
		}
		sample["phase"], sample["complete"] = "complete", true
	}
	return ctx.Err()
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
