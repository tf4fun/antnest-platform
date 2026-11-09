package telemetry

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type duplexResponseBody struct {
	reader   io.Reader
	writeErr error
	writes   int
	written  bytes.Buffer
	closed   bool
}

func (b *duplexResponseBody) Read(p []byte) (int, error) { return b.reader.Read(p) }

func (b *duplexResponseBody) Write(p []byte) (int, error) {
	b.writes++
	if b.writeErr != nil {
		return 0, b.writeErr
	}
	return b.written.Write(p)
}

func (b *duplexResponseBody) Close() error {
	b.closed = true
	return nil
}

func TestSharedServerWriterRecordsUpgradeStatus(t *testing.T) {
	recorder := nativeSpans(t)
	response := httptest.NewRecorder()
	HTTPHandler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusSwitchingProtocols)
	})).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/upgrade", nil))
	ended := recorder.Ended()
	if len(ended) != 1 {
		t.Fatalf("expected one server span: %v", ended)
	}
	status := -1
	for _, attr := range ended[0].Attributes() {
		if attr.Key == "http.response.status_code" {
			status = int(attr.Value.AsInt64())
		}
	}
	if status != http.StatusSwitchingProtocols || response.Code != http.StatusSwitchingProtocols {
		t.Fatalf("101 upgrade status not recorded: status_code=%d code=%d", status, response.Code)
	}
}

func TestSharedClientRetainsDuplexBodyWriter(t *testing.T) {
	recorder := nativeSpans(t)
	marker := errors.New("marker")
	body := &duplexResponseBody{reader: strings.NewReader("")}
	client := HTTPClient(&http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: body, Request: request}, nil
	})}, "agent-acp-service")
	request, err := http.NewRequest(http.MethodGet, "http://source.invalid", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	writer, ok := response.Body.(io.Writer)
	if !ok {
		t.Fatalf("duplex response body lost Writer: %T", response.Body)
	}
	if n, err := writer.Write([]byte("ping")); n != 4 || err != nil || body.written.String() != "ping" || body.writes != 1 {
		t.Fatalf("duplex write not preserved: %d %v %q %d", n, err, body.written.String(), body.writes)
	}
	body.writeErr = marker
	if n, err := writer.Write([]byte("x")); n != 0 || err != marker {
		t.Fatalf("duplex write error not preserved: %d %v", n, err)
	}
	if err := response.Body.Close(); err != nil || !body.closed {
		t.Fatalf("duplex close not preserved: %v", err)
	}
	_ = response.Body.Close()
	if ended := recorder.Ended(); len(ended) != 1 {
		t.Fatalf("duplex body did not settle the client span exactly once: %v", ended)
	}
}
