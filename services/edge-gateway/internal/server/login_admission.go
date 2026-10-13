package server

import (
	"container/list"
	"crypto/sha256"
	"encoding/binary"
	"io"
	"net/netip"
	"strings"
	"sync"
	"time"
)

type loginAdmissionFlow string
type loginAdmissionOutcome string

const (
	loginFlowPassword loginAdmissionFlow = "password"
	loginFlowOIDC     loginAdmissionFlow = "oidc_start"

	loginAdmitted       loginAdmissionOutcome = "admitted"
	loginSourceLimited  loginAdmissionOutcome = "source_limited"
	loginAccountLimited loginAdmissionOutcome = "account_limited"
	loginEvicted        loginAdmissionOutcome = "evicted"
)

type loginAdmissionConfig struct {
	Window          time.Duration
	SourceLimit     int
	AccountLimit    int
	OIDCSourceLimit int
	MaxKeys         int
	Now             func() time.Time
	Observe         func(loginAdmissionFlow, loginAdmissionOutcome)
}

type loginAdmissionKey [sha256.Size]byte

type loginWindow struct {
	key       loginAdmissionKey
	expiresAt time.Time
	count     int
}

// Fixed windows share a duration, so insertion order is also expiry order.
// Every retained key owns exactly one node; replacement removes the old node.
type loginAdmissionTable struct {
	entries map[loginAdmissionKey]*list.Element
	order   list.List
}

type loginAdmission struct {
	mu              sync.Mutex
	window          time.Duration
	sourceLimit     int
	accountLimit    int
	oidcSourceLimit int
	maxKeys         int
	now             func() time.Time
	observe         func(loginAdmissionFlow, loginAdmissionOutcome)
	sources         loginAdmissionTable
	accounts        loginAdmissionTable
	oidcSources     loginAdmissionTable
}

func newLoginAdmission(config loginAdmissionConfig) *loginAdmission {
	if config.Window <= 0 {
		config.Window = defaultLoginWindow
	}
	if config.SourceLimit <= 0 {
		config.SourceLimit = defaultLoginSourceMax
	}
	if config.AccountLimit <= 0 {
		config.AccountLimit = defaultLoginAccountMax
	}
	if config.OIDCSourceLimit <= 0 {
		config.OIDCSourceLimit = defaultOIDCStartSourceMax
	}
	if config.MaxKeys <= 0 {
		config.MaxKeys = defaultLoginMaxKeys
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	return &loginAdmission{
		window: config.Window, sourceLimit: config.SourceLimit,
		accountLimit: config.AccountLimit, oidcSourceLimit: config.OIDCSourceLimit,
		maxKeys: config.MaxKeys, now: config.Now, observe: config.Observe,
		sources:     loginAdmissionTable{entries: make(map[loginAdmissionKey]*list.Element)},
		accounts:    loginAdmissionTable{entries: make(map[loginAdmissionKey]*list.Element)},
		oidcSources: loginAdmissionTable{entries: make(map[loginAdmissionKey]*list.Element)},
	}
}

func (admission *loginAdmission) AllowPassword(source, organization, email string) bool {
	account := digestLoginAdmissionKey(
		"antnest.edge-gateway.login-admission/password/v1",
		strings.ToLower(strings.TrimSpace(organization)),
		strings.ToLower(strings.TrimSpace(email)),
	)
	outcome := admission.decide(&admission.sources, loginSourceKey(source), admission.sourceLimit, &account)
	return admission.record(loginFlowPassword, outcome)
}

func (admission *loginAdmission) AllowOIDCStart(source string) bool {
	outcome := admission.decide(&admission.oidcSources, loginSourceKey(source), admission.oidcSourceLimit, nil)
	return admission.record(loginFlowOIDC, outcome)
}

func (admission *loginAdmission) decide(
	sources *loginAdmissionTable, source loginAdmissionKey, sourceLimit int, account *loginAdmissionKey,
) loginAdmissionOutcome {
	admission.mu.Lock()
	defer admission.mu.Unlock()
	// Sample under the mutex so concurrent insertions cannot invert expiry order.
	now := admission.now()
	// Rejection is read-only, including expired entries in every table.
	if sources.count(source, now) >= sourceLimit {
		return loginSourceLimited
	}
	if account != nil && admission.accounts.count(*account, now) >= admission.accountLimit {
		return loginAccountLimited
	}
	evicted := sources.admit(source, now, admission.window, admission.maxKeys)
	if account != nil {
		accountEvicted := admission.accounts.admit(*account, now, admission.window, admission.maxKeys)
		evicted = evicted || accountEvicted
	}
	if evicted {
		return loginEvicted
	}
	return loginAdmitted
}

func (admission *loginAdmission) record(flow loginAdmissionFlow, outcome loginAdmissionOutcome) bool {
	// Do not hold the admission mutex while calling the telemetry provider.
	if admission.observe != nil {
		admission.observe(flow, outcome)
	}
	return outcome == loginAdmitted || outcome == loginEvicted
}

func (table *loginAdmissionTable) count(key loginAdmissionKey, now time.Time) int {
	if node := table.entries[key]; node != nil {
		window := node.Value.(*loginWindow)
		if now.Before(window.expiresAt) {
			return window.count
		}
	}
	return 0
}

func (table *loginAdmissionTable) admit(key loginAdmissionKey, now time.Time, duration time.Duration, maxKeys int) bool {
	for node := table.order.Front(); node != nil; node = table.order.Front() {
		if now.Before(node.Value.(*loginWindow).expiresAt) {
			break
		}
		table.remove(node)
	}
	if node := table.entries[key]; node != nil {
		node.Value.(*loginWindow).count++
		return false
	}
	evicted := len(table.entries) >= maxKeys
	if evicted {
		table.remove(table.order.Front())
	}
	window := &loginWindow{key: key, expiresAt: now.Add(duration), count: 1}
	table.entries[key] = table.order.PushBack(window)
	return evicted
}

func (table *loginAdmissionTable) remove(node *list.Element) {
	delete(table.entries, node.Value.(*loginWindow).key)
	table.order.Remove(node)
}

func loginSourceKey(source string) loginAdmissionKey {
	canonical := "unknown"
	if address, err := netip.ParseAddr(strings.TrimSpace(source)); err == nil && address.Zone() == "" {
		address = address.Unmap()
		if address.Is4() {
			canonical = address.String()
		} else {
			canonical = netip.PrefixFrom(address, 64).Masked().String()
		}
	}
	return digestLoginAdmissionKey("antnest.edge-gateway.login-admission/source/v1", canonical)
}

func digestLoginAdmissionKey(parts ...string) loginAdmissionKey {
	digest := sha256.New()
	var length [8]byte
	for _, part := range parts {
		binary.BigEndian.PutUint64(length[:], uint64(len(part)))
		_, _ = digest.Write(length[:])
		_, _ = io.WriteString(digest, part)
	}
	var key loginAdmissionKey
	copy(key[:], digest.Sum(nil))
	return key
}
