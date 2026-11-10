package telemetry

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

func StartServer(
	request *http.Request,
	instrumentation string,
	propagator propagation.TextMapPropagator,
	options ...trace.SpanStartOption,
) (context.Context, trace.Span) {
	return StartServerWithTracer(request, otel.Tracer(instrumentation), propagator, options...)
}

func StartServerWithTracer(
	request *http.Request,
	tracer trace.Tracer,
	propagator propagation.TextMapPropagator,
	options ...trace.SpanStartOption,
) (context.Context, trace.Span) {
	if propagator == nil {
		propagator = propagation.TraceContext{}
	}
	ctx := propagator.Extract(
		request.Context(),
		propagation.HeaderCarrier(request.Header),
	)
	options = append(
		[]trace.SpanStartOption{trace.WithSpanKind(trace.SpanKindServer)},
		options...,
	)
	return tracer.Start(ctx, "HTTP "+request.Method, options...)
}

func CloneRequest(
	request *http.Request,
	ctx context.Context,
	propagator propagation.TextMapPropagator,
) *http.Request {
	if propagator == nil {
		propagator = propagation.TraceContext{}
	}
	clone := request.Clone(ctx)
	clone.Header = request.Header.Clone()
	if clone.Header == nil {
		clone.Header = http.Header{}
	}
	clone.Header.Del("Baggage")
	propagator.Inject(ctx, propagation.HeaderCarrier(clone.Header))
	return clone
}

type BodyCallbacks struct {
	Read  func(int, error)
	Close func(error)
	Write func(int, error)
}

type wrappedBody struct {
	body      io.ReadCloser
	callbacks BodyCallbacks
}

type duplexBody struct {
	wrappedBody
}

func (b *wrappedBody) Read(p []byte) (int, error) {
	n, err := b.body.Read(p)
	if b.callbacks.Read != nil {
		b.callbacks.Read(n, err)
	}
	return n, err
}

func (b *wrappedBody) Close() error {
	err := b.body.Close()
	if b.callbacks.Close != nil {
		b.callbacks.Close(err)
	}
	return err
}

func (b *duplexBody) Write(p []byte) (int, error) {
	n, err := b.body.(io.Writer).Write(p)
	if b.callbacks.Write != nil {
		b.callbacks.Write(n, err)
	}
	return n, err
}

func WrapBody(body io.ReadCloser, callbacks BodyCallbacks) io.ReadCloser {
	if body == nil || body == http.NoBody {
		return body
	}
	if _, ok := body.(io.Writer); ok {
		return &duplexBody{wrappedBody{body: body, callbacks: callbacks}}
	}
	return &wrappedBody{body: body, callbacks: callbacks}
}

type ServerWriter struct {
	http.ResponseWriter
	Ctx         context.Context
	Status      int
	WroteHeader bool
	Written     int64
	WriteErr    error
	onError     func(error)
}

func NewServerWriter(
	wrapped http.ResponseWriter,
	ctx context.Context,
	onError func(error),
) *ServerWriter {
	return &ServerWriter{
		ResponseWriter: wrapped,
		Ctx:            ctx,
		Status:         http.StatusOK,
		onError:        onError,
	}
}

func (w *ServerWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func (w *ServerWriter) recordError(err error) {
	if err == nil || w.WriteErr != nil {
		return
	}
	w.WriteErr = err
	if w.onError != nil {
		w.onError(err)
	}
}

func (w *ServerWriter) WriteHeader(status int) {
	if w.WroteHeader {
		return
	}
	if status >= 100 && status < 200 && status != http.StatusSwitchingProtocols {
		w.ResponseWriter.WriteHeader(status)
		return
	}
	w.WroteHeader = true
	w.Status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *ServerWriter) Write(p []byte) (int, error) {
	if !w.WroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	n, err := w.ResponseWriter.Write(p)
	w.Written += int64(n)
	w.recordError(err)
	return n, err
}

func (w *ServerWriter) Flush() {
	_ = w.FlushError()
}

func (w *ServerWriter) FlushError() error {
	if !w.WroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	var err error
	if flusher, ok := w.ResponseWriter.(interface{ FlushError() error }); ok {
		err = flusher.FlushError()
	} else {
		err = http.NewResponseController(w.ResponseWriter).Flush()
	}
	w.recordError(err)
	return err
}

func (w *ServerWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return http.NewResponseController(w.ResponseWriter).Hijack()
}

func (w *ServerWriter) Push(target string, options *http.PushOptions) error {
	if pusher, ok := w.ResponseWriter.(http.Pusher); ok {
		return pusher.Push(target, options)
	}
	return http.ErrNotSupported
}

func (w *ServerWriter) ReadFrom(r io.Reader) (int64, error) {
	return io.Copy(struct{ io.Writer }{w}, r)
}
