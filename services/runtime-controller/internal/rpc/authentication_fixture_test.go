package rpc

import (
	"crypto/sha256"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/observation"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/serviceauth"
)

const controllerTestToken = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"

func fixtureSecurity() Security {
	digest := sha256.Sum256([]byte(strings.Repeat("A", 43)))
	receiver, err := serviceauth.ParseReceiver("runtime-controller", []byte(fmt.Sprintf(`{"agent-controller":["sha256:ea866a757e4c38babfa8127cbe9a409d3e1f93a00ff1488ff735fcf917afffd0"],"skill-registry":["sha256:%x"]}`, digest)), false)
	if err != nil {
		panic(err)
	}
	return Security{Authentication: receiver}
}

type authenticatedFixture struct{ *Handler }

func (h *authenticatedFixture) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	r.Header.Set(serviceauth.Header, "Bearer "+controllerTestToken)
	if r.Method == http.MethodPost {
		r.Header.Set("Content-Type", "application/json")
	}
	if r.URL.Path == "/status" {
		r.RemoteAddr = "127.0.0.1:12345"
	}
	h.Handler.ServeHTTP(w, r)
}

// Existing business tests use a valid caller; security tests use NewHandler
// directly so the fixture cannot hide missing or wrong credentials/media.
func newAuthenticatedHandler(service Service, hub *observation.Hub, heartbeat, timeout time.Duration, preparations ...SkillPreparationService) (http.Handler, error) {
	handler, err := NewHandler(service, hub, heartbeat, timeout, fixtureSecurity(), preparations...)
	if err != nil {
		return nil, err
	}
	return &authenticatedFixture{Handler: handler}, nil
}
