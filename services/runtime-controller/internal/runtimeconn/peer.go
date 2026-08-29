package runtimeconn

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

const (
	defaultMaxMessageBytes   = 16 << 20
	defaultTombstoneLimit    = 1024
	defaultHandlerDrainLimit = time.Second
)

var (
	ErrPeerClosed        = errors.New("JSON-RPC peer is closed")
	ErrCallNotDispatched = errors.New("JSON-RPC call was not dispatched")
)

type connection interface {
	ReadMessage() (int, []byte, error)
	WriteMessage(int, []byte) error
	SetReadLimit(int64)
	SetReadDeadline(time.Time) error
	SetWriteDeadline(time.Time) error
	Close() error
}

type Handler func(context.Context, json.RawMessage) (any, *Error)

type Peer struct {
	conn         connection
	localPrefix  string
	remotePrefix string
	handlers     map[string]Handler
	nextID       atomic.Uint64

	writeGate    chan struct{}
	mu           sync.Mutex
	pending      map[string]chan response
	dead         map[string]struct{}
	order        []string
	closed       bool
	closeCh      chan struct{}
	handlerSlots chan struct{}
	prepareRead  func() error
}

type response struct {
	result json.RawMessage
	err    error
}

func NewPeer(
	conn *websocket.Conn,
	localPrefix string,
	remotePrefix string,
	handlers map[string]Handler,
) (*Peer, error) {
	return newPeerWithLimit(conn, localPrefix, remotePrefix, handlers, defaultMaxMessageBytes)
}

func newPeer(
	conn connection,
	localPrefix string,
	remotePrefix string,
	handlers map[string]Handler,
) (*Peer, error) {
	return newPeerWithLimit(conn, localPrefix, remotePrefix, handlers, defaultMaxMessageBytes)
}

func newPeerWithLimit(
	conn connection,
	localPrefix string,
	remotePrefix string,
	handlers map[string]Handler,
	maxMessageBytes int,
) (*Peer, error) {
	if conn == nil || !validPrefix(localPrefix) || !validPrefix(remotePrefix) || localPrefix == remotePrefix {
		return nil, fmt.Errorf("JSON-RPC connection and distinct id prefixes are required")
	}
	if maxMessageBytes <= 0 {
		return nil, fmt.Errorf("JSON-RPC maximum message size must be positive")
	}
	cloned := make(map[string]Handler, len(handlers))
	for method, handler := range handlers {
		method = strings.TrimSpace(method)
		if method == "" || handler == nil {
			return nil, fmt.Errorf("JSON-RPC handlers require a method and implementation")
		}
		cloned[method] = handler
	}
	conn.SetReadLimit(int64(maxMessageBytes))
	return &Peer{
		conn: conn, localPrefix: localPrefix, remotePrefix: remotePrefix, handlers: cloned,
		pending: make(map[string]chan response), dead: make(map[string]struct{}), closeCh: make(chan struct{}),
		handlerSlots: make(chan struct{}, 64), writeGate: make(chan struct{}, 1),
	}, nil
}

func validPrefix(value string) bool {
	value = strings.TrimSpace(value)
	return value != "" && strings.HasSuffix(value, "-")
}

func (p *Peer) Serve(ctx context.Context) error {
	return p.ServeWithDisconnect(ctx, nil)
}

func (p *Peer) ServeWithDisconnect(ctx context.Context, disconnected func(error)) error {
	if p == nil {
		return ErrPeerClosed
	}
	serveCtx, cancel := context.WithCancel(ctx)
	var handlers sync.WaitGroup
	serveErr := p.readLoop(ctx, serveCtx, &handlers)
	cancel()
	p.closeWith(ErrPeerClosed)
	if disconnected != nil {
		disconnected(serveErr)
	}
	return errors.Join(serveErr, waitForHandlers(&handlers, defaultHandlerDrainLimit))
}

func (p *Peer) readLoop(ctx context.Context, serveCtx context.Context, handlers *sync.WaitGroup) error {
	for {
		if p.prepareRead != nil {
			if err := p.prepareRead(); err != nil {
				return fmt.Errorf("prepare JSON-RPC control read: %w", err)
			}
		}
		messageType, data, err := p.conn.ReadMessage()
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return err
		}
		if messageType != websocket.TextMessage {
			return fmt.Errorf("JSON-RPC control connection received non-text frame")
		}
		envelope, err := decodeMessage(data)
		if err != nil {
			return fmt.Errorf("decode JSON-RPC control message: %w", err)
		}
		if envelope.Method != "" {
			if envelope.ID == nil {
				return fmt.Errorf("JSON-RPC notifications are not supported")
			}
			select {
			case p.handlerSlots <- struct{}{}:
				handlers.Add(1)
				go p.runHandler(serveCtx, envelope, handlers)
			default:
				return fmt.Errorf("JSON-RPC request concurrency limit exceeded")
			}
			continue
		}
		if err := p.deliverResponse(envelope); err != nil {
			return err
		}
	}
}

func (p *Peer) runHandler(ctx context.Context, request message, handlers *sync.WaitGroup) {
	defer handlers.Done()
	defer func() { <-p.handlerSlots }()
	defer func() {
		if recover() != nil {
			p.closeWith(fmt.Errorf("JSON-RPC request handler panicked"))
			_ = p.conn.Close()
		}
	}()
	p.handleRequest(ctx, request)
}

func waitForHandlers(handlers *sync.WaitGroup, limit time.Duration) error {
	done := make(chan struct{})
	go func() {
		handlers.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-time.After(limit):
		return fmt.Errorf("JSON-RPC request handlers did not stop within %s", limit)
	}
}

func (p *Peer) Call(ctx context.Context, method string, params any, target any) error {
	if p == nil || strings.TrimSpace(method) == "" || target == nil {
		return fmt.Errorf("%w: complete JSON-RPC call is required", ErrCallNotDispatched)
	}
	id := p.localPrefix + strconv.FormatUint(p.nextID.Add(1), 10)
	wait := make(chan response, 1)
	if err := p.addPending(id, wait); err != nil {
		return fmt.Errorf("%w: %w", ErrCallNotDispatched, err)
	}
	payload, err := marshalRequest(&id, method, params)
	if err != nil {
		p.removePending(id, false)
		return fmt.Errorf("%w: %w", ErrCallNotDispatched, err)
	}
	dispatched, err := p.write(ctx, payload)
	if err != nil {
		p.removePending(id, false)
		if !dispatched {
			return fmt.Errorf("%w: %w", ErrCallNotDispatched, err)
		}
		return err
	}
	select {
	case reply := <-wait:
		if reply.err != nil {
			return reply.err
		}
		if err := decodeJSONStrict(reply.result, target); err != nil {
			return fmt.Errorf("decode JSON-RPC %s result: %w", method, err)
		}
		return nil
	case <-ctx.Done():
		p.removePending(id, true)
		return ctx.Err()
	case <-p.closeCh:
		return ErrPeerClosed
	}
}

func (p *Peer) Close() error {
	if p == nil {
		return nil
	}
	p.closeWith(ErrPeerClosed)
	return p.conn.Close()
}

func (p *Peer) handleRequest(ctx context.Context, request message) {
	if request.ID != nil && !strings.HasPrefix(*request.ID, p.remotePrefix) {
		p.closeWith(fmt.Errorf("JSON-RPC request id has invalid direction"))
		_ = p.conn.Close()
		return
	}
	handler := p.handlers[request.Method]
	if handler == nil {
		_ = p.writeResponse(ctx, *request.ID, nil, &Error{Code: CodeMethodNotFound, Message: "method not found"})
		return
	}
	result, rpcErr := handler(ctx, request.Params)
	if err := p.writeResponse(ctx, *request.ID, result, rpcErr); err != nil {
		p.closeWith(err)
		_ = p.conn.Close()
	}
}

func (p *Peer) deliverResponse(envelope message) error {
	id := *envelope.ID
	if !strings.HasPrefix(id, p.localPrefix) {
		return fmt.Errorf("JSON-RPC response id has invalid direction")
	}
	p.mu.Lock()
	wait := p.pending[id]
	if wait != nil {
		delete(p.pending, id)
	}
	_, late := p.dead[id]
	p.mu.Unlock()
	if wait == nil {
		if late {
			return nil
		}
		return fmt.Errorf("JSON-RPC response id %q is unknown", id)
	}
	if envelope.Error != nil {
		wait <- response{err: envelope.Error}
	} else {
		wait <- response{result: envelope.Result}
	}
	return nil
}

func (p *Peer) writeResponse(ctx context.Context, id string, result any, rpcErr *Error) error {
	payload, err := marshalResponse(id, result, rpcErr)
	if err != nil {
		payload, _ = marshalResponse(id, nil, &Error{Code: CodeInternalError, Message: "encode response"})
	}
	_, err = p.write(ctx, payload)
	return err
}

func (p *Peer) write(ctx context.Context, payload []byte) (bool, error) {
	select {
	case p.writeGate <- struct{}{}:
		defer func() { <-p.writeGate }()
	case <-ctx.Done():
		return false, ctx.Err()
	case <-p.closeCh:
		return false, ErrPeerClosed
	}
	p.mu.Lock()
	closed := p.closed
	p.mu.Unlock()
	if closed {
		return false, ErrPeerClosed
	}
	deadline := time.Now().Add(10 * time.Second)
	if contextDeadline, ok := ctx.Deadline(); ok && contextDeadline.Before(deadline) {
		deadline = contextDeadline
	}
	if err := p.conn.SetWriteDeadline(deadline); err != nil {
		return false, err
	}
	return true, p.conn.WriteMessage(websocket.TextMessage, payload)
}

func (p *Peer) addPending(id string, wait chan response) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return ErrPeerClosed
	}
	p.pending[id] = wait
	return nil
}

func (p *Peer) removePending(id string, tombstone bool) {
	p.mu.Lock()
	delete(p.pending, id)
	if tombstone {
		p.dead[id] = struct{}{}
		p.order = append(p.order, id)
		if len(p.order) > defaultTombstoneLimit {
			delete(p.dead, p.order[0])
			p.order = p.order[1:]
		}
	}
	p.mu.Unlock()
}

func (p *Peer) closeWith(cause error) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	close(p.closeCh)
	pending := p.pending
	p.pending = make(map[string]chan response)
	p.mu.Unlock()
	for _, wait := range pending {
		wait <- response{err: cause}
	}
}
