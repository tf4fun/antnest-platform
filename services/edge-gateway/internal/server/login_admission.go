package server

import (
	"strings"
	"sync"
	"time"
)

type loginAdmissionConfig struct {
	Window       time.Duration
	SourceLimit  int
	AccountLimit int
	MaxKeys      int
	Now          func() time.Time
}

type loginWindow struct {
	startedAt time.Time
	count     int
}

type loginAdmission struct {
	mu           sync.Mutex
	window       time.Duration
	sourceLimit  int
	accountLimit int
	maxKeys      int
	now          func() time.Time
	sources      map[string]loginWindow
	accounts     map[string]loginWindow
}

func newLoginAdmission(config loginAdmissionConfig) *loginAdmission {
	return &loginAdmission{
		window: config.Window, sourceLimit: config.SourceLimit,
		accountLimit: config.AccountLimit, maxKeys: config.MaxKeys, now: config.Now,
		sources: make(map[string]loginWindow), accounts: make(map[string]loginWindow),
	}
}

func (admission *loginAdmission) Allow(source, organization, email string) bool {
	now := admission.now()
	source = strings.TrimSpace(source)
	account := strings.ToLower(strings.TrimSpace(organization)) + "\x00" +
		strings.ToLower(strings.TrimSpace(email))

	admission.mu.Lock()
	defer admission.mu.Unlock()
	sourceWindow, sourceExists := admission.current(admission.sources, source, now)
	accountWindow, accountExists := admission.current(admission.accounts, account, now)
	if sourceWindow.count >= admission.sourceLimit || accountWindow.count >= admission.accountLimit {
		return false
	}
	if !sourceExists && len(admission.sources) >= admission.maxKeys {
		admission.pruneExpired(admission.sources, now)
	}
	if !accountExists && len(admission.accounts) >= admission.maxKeys {
		admission.pruneExpired(admission.accounts, now)
	}
	if (!sourceExists && len(admission.sources) >= admission.maxKeys) ||
		(!accountExists && len(admission.accounts) >= admission.maxKeys) {
		return false
	}
	sourceWindow.count++
	accountWindow.count++
	admission.sources[source] = sourceWindow
	admission.accounts[account] = accountWindow
	return true
}

func (admission *loginAdmission) pruneExpired(windows map[string]loginWindow, now time.Time) {
	for key, window := range windows {
		if !now.Before(window.startedAt.Add(admission.window)) {
			delete(windows, key)
		}
	}
}

func (admission *loginAdmission) current(
	windows map[string]loginWindow, key string, now time.Time,
) (loginWindow, bool) {
	window, exists := windows[key]
	if !exists || !now.Before(window.startedAt.Add(admission.window)) {
		if exists {
			delete(windows, key)
		}
		return loginWindow{startedAt: now}, false
	}
	return window, true
}
