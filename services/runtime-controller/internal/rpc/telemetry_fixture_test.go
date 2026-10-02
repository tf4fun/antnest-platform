package rpc

import (
	"context"
	"fmt"
	"os"
	"testing"

	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

var rpcTestTracerProvider *sdktrace.TracerProvider

func TestMain(m *testing.M) {
	// Package tracers bind to the first global SDK provider. Keep it alive for
	// the test process; individual tests attach and remove their own recorder.
	rpcTestTracerProvider = sdktrace.NewTracerProvider()
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(rpcTestTracerProvider)
	exitCode := m.Run()
	otel.SetTracerProvider(previous)
	if err := rpcTestTracerProvider.Shutdown(context.Background()); err != nil {
		fmt.Fprintln(os.Stderr, "shutdown RPC test tracer provider:", err)
		exitCode = 1
	}
	os.Exit(exitCode)
}
