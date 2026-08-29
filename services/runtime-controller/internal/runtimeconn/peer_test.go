package runtimeconn

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestPeerCorrelatesCallsAndIgnoresLateTimedOutResponse(t *testing.T) {
	releaseSlow := make(chan struct{})
	controlConn, runtimeConn := newMemoryConnectionPair()
	runtimePeer, err := newPeer(runtimeConn, "rt-", "cp-", map[string]Handler{
		"echo": func(_ context.Context, params json.RawMessage) (any, *Error) {
			var value struct {
				Value string `json:"value"`
			}
			if err := json.Unmarshal(params, &value); err != nil {
				return nil, &Error{Code: CodeInvalidParams, Message: err.Error()}
			}
			return value, nil
		},
		"slow": func(context.Context, json.RawMessage) (any, *Error) {
			<-releaseSlow
			return struct {
				Done bool `json:"done"`
			}{Done: true}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	client, err := newPeer(controlConn, "cp-", "rt-", nil)
	if err != nil {
		t.Fatal(err)
	}
	serveDone := make(chan error, 2)
	go func() { serveDone <- client.Serve(t.Context()) }()
	go func() { serveDone <- runtimePeer.Serve(t.Context()) }()
	defer func() {
		_ = client.Close()
		<-serveDone
		<-serveDone
	}()

	var echoed struct {
		Value string `json:"value"`
	}
	if err := client.Call(t.Context(), "echo", map[string]any{"value": "hello"}, &echoed); err != nil {
		t.Fatal(err)
	}
	if echoed.Value != "hello" {
		t.Fatalf("echo result = %#v", echoed)
	}

	timeoutCtx, cancel := context.WithTimeout(t.Context(), 10*time.Millisecond)
	defer cancel()
	var slow struct {
		Done bool `json:"done"`
	}
	if err := client.Call(timeoutCtx, "slow", struct{}{}, &slow); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("slow call error = %v", err)
	}
	close(releaseSlow)
	time.Sleep(10 * time.Millisecond)
	if err := client.Call(t.Context(), "echo", map[string]any{"value": "still-open"}, &echoed); err != nil {
		t.Fatalf("late response closed peer: %v", err)
	}
}

func TestPeerCallDeadlineIncludesWriteQueue(t *testing.T) {
	controlConn, _ := newMemoryConnectionPair()
	peer, err := newPeer(controlConn, "cp-", "rt-", nil)
	if err != nil {
		t.Fatal(err)
	}
	peer.writeGate <- struct{}{}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Millisecond)
	defer cancel()
	var result struct{}
	err = peer.Call(ctx, "queued", struct{}{}, &result)
	<-peer.writeGate
	if !errors.Is(err, ErrCallNotDispatched) || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("queued call was not classified as undispatched timeout: %v", err)
	}
}

func TestPeerConfiguredLimitCarriesBase64WrappedFilePayload(t *testing.T) {
	controlConn, runtimeConn := newMemoryConnectionPair()
	runtimePeer, err := newPeerWithLimit(runtimeConn, "rt-", "cp-", map[string]Handler{
		"size": func(_ context.Context, params json.RawMessage) (any, *Error) {
			var input struct {
				Content []byte `json:"content"`
			}
			if err := json.Unmarshal(params, &input); err != nil {
				return nil, &Error{Code: CodeInvalidParams, Message: err.Error()}
			}
			return struct {
				Size int `json:"size"`
			}{Size: len(input.Content)}, nil
		},
	}, 16<<20)
	if err != nil {
		t.Fatal(err)
	}
	client, err := newPeerWithLimit(controlConn, "cp-", "rt-", nil, 16<<20)
	if err != nil {
		t.Fatal(err)
	}
	serveDone := make(chan error, 2)
	go func() { serveDone <- client.Serve(t.Context()) }()
	go func() { serveDone <- runtimePeer.Serve(t.Context()) }()
	defer func() {
		_ = client.Close()
		<-serveDone
		<-serveDone
	}()

	content := make([]byte, 5<<20)
	for index := range content {
		content[index] = byte(index)
	}
	var result struct {
		Size int `json:"size"`
	}
	if err := client.Call(t.Context(), "size", struct {
		Content []byte `json:"content"`
	}{Content: content}, &result); err != nil {
		t.Fatal(err)
	}
	if result.Size != len(content) {
		t.Fatalf("decoded payload size = %d, want %d", result.Size, len(content))
	}
}

func TestPeerServeCancelsAndJoinsRequestHandlers(t *testing.T) {
	controlConn, runtimeConn := newMemoryConnectionPair()
	started := make(chan struct{})
	stopped := make(chan struct{})
	peer, err := newPeer(runtimeConn, "rt-", "cp-", map[string]Handler{
		"block": func(ctx context.Context, _ json.RawMessage) (any, *Error) {
			close(started)
			<-ctx.Done()
			close(stopped)
			return struct{}{}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	serveDone := make(chan error, 1)
	go func() { serveDone <- peer.Serve(t.Context()) }()
	payload, err := marshalRequest(pointer("cp-1"), "block", struct{}{})
	if err != nil {
		t.Fatal(err)
	}
	if err := controlConn.WriteMessage(websocket.TextMessage, payload); err != nil {
		t.Fatal(err)
	}
	<-started
	if err := controlConn.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-serveDone:
	case <-time.After(time.Second):
		t.Fatal("Serve did not wait for the canceled handler")
	}
	select {
	case <-stopped:
	default:
		t.Fatal("Serve returned before the request handler stopped")
	}
}

func TestPeerServeBoundsHandlerDrainAfterDisconnect(t *testing.T) {
	controlConn, runtimeConn := newMemoryConnectionPair()
	started := make(chan struct{})
	release := make(chan struct{})
	peer, err := newPeer(runtimeConn, "rt-", "cp-", map[string]Handler{
		"ignore-cancel": func(context.Context, json.RawMessage) (any, *Error) {
			close(started)
			<-release
			return struct{}{}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	serveDone := make(chan error, 1)
	go func() { serveDone <- peer.Serve(t.Context()) }()
	payload, err := marshalRequest(pointer("cp-1"), "ignore-cancel", struct{}{})
	if err != nil {
		t.Fatal(err)
	}
	if err := controlConn.WriteMessage(websocket.TextMessage, payload); err != nil {
		t.Fatal(err)
	}
	<-started
	if err := controlConn.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-serveDone:
		if err == nil || !strings.Contains(err.Error(), "handlers did not stop") {
			t.Fatalf("unbounded handler drain returned %v", err)
		}
	case <-time.After(2 * defaultHandlerDrainLimit):
		t.Fatal("Serve remained blocked behind a handler that ignored cancellation")
	}
	close(release)
}

func TestPeerRejectsNotificationsWithoutInvokingHandler(t *testing.T) {
	controlConn, runtimeConn := newMemoryConnectionPair()
	var calls atomic.Int32
	peer, err := newPeer(runtimeConn, "rt-", "cp-", map[string]Handler{
		"mutate": func(context.Context, json.RawMessage) (any, *Error) {
			calls.Add(1)
			return struct{}{}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	serveDone := make(chan error, 1)
	go func() { serveDone <- peer.Serve(t.Context()) }()
	payload, err := marshalRequest(nil, "mutate", struct{}{})
	if err != nil {
		t.Fatal(err)
	}
	if err := controlConn.WriteMessage(websocket.TextMessage, payload); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-serveDone:
		if err == nil || !strings.Contains(err.Error(), "notifications are not supported") {
			t.Fatalf("notification rejection = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("notification did not close the JSON-RPC peer")
	}
	if calls.Load() != 0 {
		t.Fatalf("notification invoked a side-effecting handler: calls=%d", calls.Load())
	}
}

func TestPeerContainsHandlerPanicToConnection(t *testing.T) {
	controlConn, runtimeConn := newMemoryConnectionPair()
	peer, err := newPeer(runtimeConn, "rt-", "cp-", map[string]Handler{
		"panic": func(context.Context, json.RawMessage) (any, *Error) {
			panic("private handler detail")
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	serveDone := make(chan error, 1)
	go func() { serveDone <- peer.Serve(t.Context()) }()
	payload, err := marshalRequest(pointer("cp-1"), "panic", struct{}{})
	if err != nil {
		t.Fatal(err)
	}
	if err := controlConn.WriteMessage(websocket.TextMessage, payload); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-serveDone:
		if err == nil || strings.Contains(err.Error(), "private handler detail") {
			t.Fatalf("handler panic was not contained safely: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("panicking handler did not close the JSON-RPC peer")
	}
}

func pointer(value string) *string { return &value }

type memoryFrame struct {
	kind int
	data []byte
}

type memoryPipe struct {
	aToB chan memoryFrame
	bToA chan memoryFrame
	done chan struct{}
	once sync.Once
}

type memoryConnection struct {
	read                <-chan memoryFrame
	write               chan<- memoryFrame
	pipe                *memoryPipe
	readLimit           atomic.Int64
	readDeadline        atomic.Int64
	readDeadlineSets    atomic.Int32
	nonzeroDeadlineSets atomic.Int32
}

type guardedReadConnection struct {
	*memoryConnection
	reading    atomic.Bool
	concurrent atomic.Bool
}

func (c *guardedReadConnection) ReadMessage() (int, []byte, error) {
	c.reading.Store(true)
	defer c.reading.Store(false)
	return c.memoryConnection.ReadMessage()
}

func (c *guardedReadConnection) SetReadDeadline(deadline time.Time) error {
	if c.reading.Load() {
		c.concurrent.Store(true)
		return errors.New("concurrent WebSocket read-side method")
	}
	return c.memoryConnection.SetReadDeadline(deadline)
}

func newMemoryConnectionPair() (*memoryConnection, *memoryConnection) {
	pipe := &memoryPipe{
		aToB: make(chan memoryFrame, 16), bToA: make(chan memoryFrame, 16), done: make(chan struct{}),
	}
	return &memoryConnection{read: pipe.bToA, write: pipe.aToB, pipe: pipe},
		&memoryConnection{read: pipe.aToB, write: pipe.bToA, pipe: pipe}
}

func (c *memoryConnection) ReadMessage() (int, []byte, error) {
	select {
	case <-c.pipe.done:
		return 0, nil, io.EOF
	case frame := <-c.read:
		if limit := c.readLimit.Load(); limit > 0 && int64(len(frame.data)) > limit {
			return 0, nil, fmt.Errorf("message exceeds read limit")
		}
		return frame.kind, append([]byte(nil), frame.data...), nil
	}
}

func (c *memoryConnection) WriteMessage(kind int, data []byte) error {
	select {
	case <-c.pipe.done:
		return io.ErrClosedPipe
	case c.write <- memoryFrame{kind: kind, data: append([]byte(nil), data...)}:
		return nil
	}
}

func (c *memoryConnection) SetReadLimit(limit int64) { c.readLimit.Store(limit) }

func (*memoryConnection) SetWriteDeadline(time.Time) error { return nil }

func (c *memoryConnection) SetReadDeadline(deadline time.Time) error {
	c.readDeadlineSets.Add(1)
	if !deadline.IsZero() {
		c.nonzeroDeadlineSets.Add(1)
	}
	value := int64(0)
	if !deadline.IsZero() {
		value = deadline.UnixNano()
	}
	c.readDeadline.Store(value)
	return nil
}

func (c *memoryConnection) Close() error {
	c.pipe.once.Do(func() { close(c.pipe.done) })
	return nil
}

func TestDecodeMessageRejectsBatchAndNonObjectParams(t *testing.T) {
	for _, input := range [][]byte{
		[]byte(`[{"jsonrpc":"2.0","method":"x"}]`),
		[]byte(`{"jsonrpc":"2.0","id":"cp-1","method":"x","params":[]}`),
		[]byte(`{"jsonrpc":"2.0","id":"cp-1","result":{},"error":{"code":-1,"message":"bad"}}`),
	} {
		if _, err := decodeMessage(input); err == nil {
			t.Fatalf("invalid JSON-RPC message was accepted: %s", input)
		}
	}
}
