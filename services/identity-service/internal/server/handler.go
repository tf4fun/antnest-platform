package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/serviceauth"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/telemetry"
	"net/http"
	"sync/atomic"
	"time"
)

type Probe interface{ Ping(context.Context) error }

type Readiness struct{ ready atomic.Bool }

func (r *Readiness) Set(value bool) { r.ready.Store(value) }

func NewHandler(probe Probe, rpcHandler, scimHandler http.Handler, authentication *serviceauth.Receiver) (http.Handler, *Readiness, error) {
	if probe == nil || rpcHandler == nil || scimHandler == nil || authentication == nil {
		return nil, nil, fmt.Errorf("identity HTTP server requires probe, RPC, and SCIM handlers")
	}
	readiness := &Readiness{}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /status", func(response http.ResponseWriter, request *http.Request) {
		ctx, cancel := context.WithTimeout(request.Context(), 2*time.Second)
		defer cancel()
		ready := readiness.ready.Load() && probe.Ping(ctx) == nil
		status := http.StatusOK
		label := "ready"
		if !ready {
			status, label = http.StatusServiceUnavailable, "not_ready"
		}
		response.Header().Set("Content-Type", "application/json")
		response.WriteHeader(status)
		_ = json.NewEncoder(response).Encode(map[string]any{
			"status": label, "live": true, "ready": ready,
		})
	})
	mux.Handle("/rpc/identity/", rpcHandler)
	mux.Handle("/protocol/oidc/callback", rpcHandler)
	mux.Handle("/scim/v2/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, failure := authentication.Authorize(r, []string{"edge-gateway"}); failure != nil {
			var rejected *serviceauth.Failure
			if !errors.As(failure, &rejected) {
				rejected = serviceauth.Unauthenticated()
			}
			telemetry.ProtocolError(w, failure)
			w.Header().Set("Content-Type", "application/json")
			if rejected.Challenge != "" {
				w.Header().Set("WWW-Authenticate", rejected.Challenge)
			}
			w.WriteHeader(rejected.Status)
			_ = json.NewEncoder(w).Encode(map[string]any{"code": rejected.Code, "message": "Service authentication rejected", "retryable": false})
			return
		}
		scimHandler.ServeHTTP(w, r)
	}))
	return mux, readiness, nil
}
