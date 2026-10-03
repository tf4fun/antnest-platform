package server

import (
	"bufio"
	"net"
	"net/http"
)

var defaultSecurityHeaders = [...]struct{ name, value string }{
	{"X-Content-Type-Options", "nosniff"},
	{"Referrer-Policy", "same-origin"},
	{"X-Frame-Options", "DENY"},
	{"Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'"},
}

// Upstream headers are copied before the proxy commits the final response.
// Apply defaults at that boundary so document owners retain their exact policy.
type securityHeaderWriter struct {
	http.ResponseWriter
	wroteHeader bool
}

func (writer *securityHeaderWriter) applyDefaults() {
	header := writer.Header()
	for _, entry := range defaultSecurityHeaders {
		if len(header.Values(entry.name)) == 0 {
			header.Set(entry.name, entry.value)
		}
	}
}

func (writer *securityHeaderWriter) WriteHeader(status int) {
	if writer.wroteHeader {
		return
	}
	if status >= 100 && status < 200 && status != http.StatusSwitchingProtocols {
		writer.ResponseWriter.WriteHeader(status)
		return
	}
	writer.applyDefaults()
	writer.wroteHeader = true
	writer.ResponseWriter.WriteHeader(status)
}

func (writer *securityHeaderWriter) Write(payload []byte) (int, error) {
	if !writer.wroteHeader {
		writer.applyDefaults()
		writer.wroteHeader = true
	}
	// Preserve the underlying writer's implicit status and Content-Type detection.
	return writer.ResponseWriter.Write(payload)
}

func (writer *securityHeaderWriter) Unwrap() http.ResponseWriter { return writer.ResponseWriter }

func (writer *securityHeaderWriter) Flush() {
	_ = writer.FlushError()
}

func (writer *securityHeaderWriter) FlushError() error {
	if !writer.wroteHeader {
		writer.WriteHeader(http.StatusOK)
	}
	return http.NewResponseController(writer.ResponseWriter).Flush()
}

func (writer *securityHeaderWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	connection, buffer, err := http.NewResponseController(writer.ResponseWriter).Hijack()
	if err == nil {
		writer.wroteHeader = true
	}
	return connection, buffer, err
}
