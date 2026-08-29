package runtimeprotocol

// Endpoint identifies one admitted Runtime realization. It contains no Agent
// model, template, or channel semantics.
type Endpoint struct {
	Provider        string            `json:"provider"`
	BaseURL         string            `json:"base_url"`
	RuntimeID       string            `json:"runtime_id,omitempty"`
	AuthTokenRef    string            `json:"-"`
	TLSMode         string            `json:"tls_mode,omitempty"`
	Labels          map[string]string `json:"labels,omitempty"`
	ResolvedAt      string            `json:"resolved_at,omitempty"`
	ExpiresAt       string            `json:"expires_at,omitempty"`
	ResolutionTrace map[string]any    `json:"resolution_trace,omitempty"`
}
