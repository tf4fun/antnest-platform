package main

import "testing"

func TestHealthProbeAddress(t *testing.T) {
	for _, fixture := range []struct{ input, expected string }{
		{"", "127.0.0.1:8080"},
		{":8123", "127.0.0.1:8123"},
		{"0.0.0.0:8123", "127.0.0.1:8123"},
		{"[::]:8123", "127.0.0.1:8123"},
		{" 127.0.0.2:8123 ", "127.0.0.2:8123"},
		{"10.241.255.50:8080", "10.241.255.50:8080"},
		{"[::1]:8123", "[::1]:8123"},
		{"[fd00::5]:8123", "[fd00::5]:8123"},
		{"edge-gateway:8080", "edge-gateway:8080"},
	} {
		t.Run(fixture.input, func(t *testing.T) {
			actual, err := healthProbeAddress(fixture.input)
			if err != nil || actual != fixture.expected {
				t.Fatalf("address = %q, error = %v; want %q", actual, err, fixture.expected)
			}
		})
	}
	for _, input := range []string{"127.0.0.1", "::1:8080", "[::1]"} {
		if _, err := healthProbeAddress(input); err == nil {
			t.Fatalf("malformed address %q was accepted", input)
		}
	}
}
