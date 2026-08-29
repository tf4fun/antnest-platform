package dnsproxy

import (
	"context"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"time"
)

const upstreamDialTimeout = 5 * time.Second

type Proxy struct {
	listenAddress string
	upstream      string

	mu       sync.Mutex
	listener net.Listener
	closed   bool
	wait     sync.WaitGroup
}

func New(listenAddress, upstream string) (*Proxy, error) {
	listenAddress = strings.TrimSpace(listenAddress)
	upstream = strings.TrimSpace(upstream)
	if listenAddress == "" || upstream == "" {
		return nil, fmt.Errorf("DNS listen and upstream addresses are required")
	}
	return &Proxy{listenAddress: listenAddress, upstream: upstream}, nil
}

func (p *Proxy) Start(ctx context.Context) error {
	listener, err := (&net.ListenConfig{}).Listen(ctx, "tcp4", p.listenAddress)
	if err != nil {
		return fmt.Errorf("listen for Runtime DNS: %w", err)
	}
	p.mu.Lock()
	if p.listener != nil || p.closed {
		p.mu.Unlock()
		_ = listener.Close()
		return fmt.Errorf("Runtime DNS proxy already started or closed")
	}
	p.listener = listener
	p.mu.Unlock()

	p.wait.Add(1)
	go p.accept(listener)
	go func() {
		<-ctx.Done()
		_ = p.Close()
	}()
	return nil
}

func (p *Proxy) Address() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.listener == nil {
		return ""
	}
	return p.listener.Addr().String()
}

func (p *Proxy) Ready() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.listener != nil && !p.closed
}

func (p *Proxy) Close() error {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil
	}
	p.closed = true
	listener := p.listener
	p.mu.Unlock()
	var err error
	if listener != nil {
		err = listener.Close()
	}
	p.wait.Wait()
	return err
}

func (p *Proxy) accept(listener net.Listener) {
	defer p.wait.Done()
	for {
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		p.wait.Add(1)
		go p.forward(connection)
	}
}

func (p *Proxy) forward(client net.Conn) {
	defer p.wait.Done()
	upstream, err := net.DialTimeout("tcp4", p.upstream, upstreamDialTimeout)
	if err != nil {
		_ = client.Close()
		return
	}
	done := make(chan struct{}, 2)
	copyStream := func(destination io.Writer, source io.Reader) {
		_, _ = io.Copy(destination, source)
		done <- struct{}{}
	}
	go copyStream(upstream, client)
	go copyStream(client, upstream)
	<-done
	_ = client.Close()
	_ = upstream.Close()
	<-done
}
