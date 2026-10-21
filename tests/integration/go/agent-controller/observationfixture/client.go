//go:build antnest_observation_consumer

package observationfixture

import (
	"net/http"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/runtimeclient"
)

func NewClient(origin string, client *http.Client) (*runtimeclient.Client, error) {
	return runtimeclient.New(origin, 5*time.Second, client)
}
