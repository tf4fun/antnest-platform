package telemetry

import "context"

type identitySessionRevocationsKey struct{}

// WithIdentitySessionRevocations identifies the owning adapter's next HTTP
// operation. It adds only a fixed method to the actual CLIENT, including when
// sending fails; it does not infer an RPC from a URL or capture its contents.
func WithIdentitySessionRevocations(ctx context.Context) context.Context {
	return context.WithValue(ctx, identitySessionRevocationsKey{}, true)
}
