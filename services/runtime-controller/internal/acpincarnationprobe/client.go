// Package acpincarnationprobe authenticates a challenge to one inspected ACP
// address while retaining the configured logical origin and workload identity.
package acpincarnationprobe

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/acpincarnation"
)

const probePath = "/internal/acp-owner/incarnation/probe"
const maxRequestBytes = 4 << 10
const maxResponseBytes = 8 << 10

// Reserve part of the two-second total budget for body/transport cleanup.
// The parent registration deadline may shorten this budget further.
const exchangeBudget = 1900 * time.Millisecond

var (
	memberID = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`)
	uuidV4   = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	hexNonce = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

type Client struct{ lookup serviceauth.LookupEnv }

var _ acpincarnation.Prober = (*Client)(nil)

func New(lookup serviceauth.LookupEnv) (*Client, error) {
	if lookup == nil {
		return nil, errors.New("ACP probe authentication configuration is required")
	}
	return &Client{lookup: lookup}, nil
}

func (c *Client) Probe(parent context.Context, member acpincarnation.Member, observation acpincarnation.Observation, input acpincarnation.ProbeRequest) (acpincarnation.ProbeRequest, error) {
	ctx, cancel := context.WithTimeout(parent, exchangeBudget)
	defer cancel()
	if ctx.Err() != nil {
		return acpincarnation.ProbeRequest{}, probeError(ctx, "cancelled")
	}
	if input.MemberID != member.ID || len(input.MemberID) < 1 || len(input.MemberID) > 64 || !memberID.MatchString(input.MemberID) ||
		len(input.IncarnationID) != 36 || !uuidV4.MatchString(input.IncarnationID) ||
		len(input.RegistrationNonce) != 64 || !hexNonce.MatchString(input.RegistrationNonce) ||
		len(input.Challenge) != 64 || !hexNonce.MatchString(input.Challenge) {
		return acpincarnation.ProbeRequest{}, probeError(ctx, "request is invalid")
	}
	origin, err := url.Parse(member.Origin)
	if err != nil || origin.Hostname() == "" || origin.User != nil || origin.Opaque != "" ||
		(origin.Scheme != "http" && origin.Scheme != "https") || (origin.Path != "" && origin.Path != "/") ||
		origin.RawQuery != "" || origin.ForceQuery || origin.Fragment != "" {
		return acpincarnation.ProbeRequest{}, probeError(ctx, "configured origin is invalid")
	}
	port := origin.Port()
	if port == "" {
		port = "80"
		if origin.Scheme == "https" {
			port = "443"
		}
	}
	portNumber, err := strconv.Atoi(port)
	address, addressErr := netip.ParseAddr(observation.Address)
	if err != nil || portNumber < 1 || portNumber > 65535 || addressErr != nil || address.Zone() != "" ||
		address.Unmap().IsUnspecified() || address.Unmap().IsMulticast() || !observation.Running {
		return acpincarnation.ProbeRequest{}, probeError(ctx, "inspected target is invalid")
	}
	payload, err := json.Marshal(input)
	if err != nil || len(payload) > maxRequestBytes {
		return acpincarnation.ProbeRequest{}, probeError(ctx, "request exceeds its limit")
	}
	// A fresh private authenticated transport prevents a pool from selecting the
	// previous container after the inspected address changes. Never mutate the
	// Controller's shared dependency transports or forward user caller context.
	auth, err := serviceauth.LoadOutbound("runtime-controller", serviceauth.WorkloadOnlyHeaders, c.lookup,
		map[string]string{"agent-acp-service": origin.Scheme + "://" + origin.Host})
	if err != nil {
		return acpincarnation.ProbeRequest{}, probeError(ctx, "authentication is unavailable")
	}
	defer auth.CloseIdleConnections()
	transport, err := auth.SocketConfig("agent-acp-service", make(http.Header))
	if err != nil {
		return acpincarnation.ProbeRequest{}, probeError(ctx, "authentication is unavailable")
	}
	logicalAddress := net.JoinHostPort(origin.Hostname(), port)
	inspectedAddress := net.JoinHostPort(address.Unmap().String(), port)
	transport.Proxy = nil
	transport.DialTLSContext = nil
	transport.DisableKeepAlives = true
	transport.DialContext = func(dialCtx context.Context, network, target string) (net.Conn, error) {
		if !strings.EqualFold(target, logicalAddress) {
			return nil, errors.New("ACP probe dial target is not configured")
		}
		return (&net.Dialer{}).DialContext(dialCtx, network, inspectedAddress)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost,
		origin.Scheme+"://"+origin.Host+probePath, bytes.NewReader(payload))
	if err != nil {
		return acpincarnation.ProbeRequest{}, probeError(ctx, "request is invalid")
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Cache-Control", "no-store")
	response, requestErr := auth.HTTPClient().Do(request)
	if response == nil || response.Body == nil {
		return acpincarnation.ProbeRequest{}, probeError(ctx, "request failed")
	}
	// Await the actual read and Close before inspecting any status, including an
	// error or redirect. The parent context bounds all network/body work.
	raw, readErr := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	closeErr := response.Body.Close()
	if requestErr != nil || readErr != nil || closeErr != nil || ctx.Err() != nil {
		return acpincarnation.ProbeRequest{}, probeError(ctx, "response did not complete")
	}
	media, _, mediaErr := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if response.StatusCode != http.StatusOK || mediaErr != nil || media != "application/json" || len(raw) > maxResponseBytes {
		return acpincarnation.ProbeRequest{}, probeError(ctx, "response is invalid")
	}
	var reply acpincarnation.ProbeRequest
	if serviceauth.DecodeObject(raw, &reply) != nil || reply.MemberID != input.MemberID || reply.IncarnationID != input.IncarnationID ||
		subtle.ConstantTimeCompare([]byte(reply.RegistrationNonce), []byte(input.RegistrationNonce)) != 1 ||
		subtle.ConstantTimeCompare([]byte(reply.Challenge), []byte(input.Challenge)) != 1 {
		return acpincarnation.ProbeRequest{}, probeError(ctx, "response identity is invalid")
	}
	return reply, nil
}

// Raw transport/peer errors may contain a private URL, nonce or credential.
// Keep only a fixed failure label and the standard cancellation identity.
func probeError(ctx context.Context, label string) error {
	if ctx.Err() != nil {
		return fmt.Errorf("ACP incarnation probe %s: %w", label, ctx.Err())
	}
	return fmt.Errorf("ACP incarnation probe %s", label)
}
