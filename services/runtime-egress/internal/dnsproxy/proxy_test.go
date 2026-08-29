package dnsproxy

import (
	"context"
	"io"
	"net"
	"testing"
	"time"
)

func TestProxyForwardsTCPDNSStream(t *testing.T) {
	upstream, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen upstream: %v", err)
	}
	t.Cleanup(func() { _ = upstream.Close() })
	go func() {
		connection, acceptErr := upstream.Accept()
		if acceptErr != nil {
			return
		}
		defer connection.Close()
		_, _ = io.Copy(connection, connection)
	}()

	proxy, err := New("127.0.0.1:0", upstream.Addr().String())
	if err != nil {
		t.Fatalf("new proxy: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if err := proxy.Start(ctx); err != nil {
		t.Fatalf("start proxy: %v", err)
	}
	t.Cleanup(func() { _ = proxy.Close() })

	client, err := net.DialTimeout("tcp4", proxy.Address(), time.Second)
	if err != nil {
		t.Fatalf("dial proxy: %v", err)
	}
	defer client.Close()
	query := []byte{0, 3, 1, 2, 3}
	if _, err := client.Write(query); err != nil {
		t.Fatalf("write query: %v", err)
	}
	response := make([]byte, len(query))
	if _, err := io.ReadFull(client, response); err != nil {
		t.Fatalf("read response: %v", err)
	}
	if string(response) != string(query) {
		t.Fatalf("response=%v want=%v", response, query)
	}
}
