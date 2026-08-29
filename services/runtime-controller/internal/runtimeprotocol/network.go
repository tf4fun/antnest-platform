package runtimeprotocol

import "errors"

const (
	AgentNetworkRestricted   = "restricted"
	AgentNetworkUnrestricted = "unrestricted"
)

var ErrDataPlaneUnavailable = errors.New("runtime egress data plane is unavailable")
