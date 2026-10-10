package session

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const testCSRFKey = "0123456789abcdef0123456789abcdef"
const testCSRFToken = "9mcP8ic4-686eM_qh1iVGgPDZV79Wrxeq-v9X8LA8hs"

func TestCookieNamesAndReadsAreExclusiveToConfiguredMode(t *testing.T) {
	for _, secure := range []bool{false, true} {
		name := "loopback-insecure"
		prefix, otherPrefix := "", "__Host-"
		if secure {
			name, prefix, otherPrefix = "secure", "__Host-", ""
		}
		t.Run(name, func(t *testing.T) {
			manager, err := NewManager(Config{Secure: secure, CSRFKey: []byte(testCSRFKey)})
			if err != nil {
				t.Fatal(err)
			}
			w := httptest.NewRecorder()
			if _, err := manager.Establish(w, "private-token", "token-1", time.Now().Add(time.Hour)); err != nil {
				t.Fatal(err)
			}
			for _, clear := range []bool{false, true} {
				if clear {
					w = httptest.NewRecorder()
					manager.Clear(w)
				}
				cookies := w.Result().Cookies()
				if len(cookies) != 2 {
					t.Fatalf("cookies=%d", len(cookies))
				}
				for i, suffix := range []string{AccessTokenCookieName, CSRFCookieName} {
					c := cookies[i]
					if c.Name != prefix+suffix || c.Secure != secure || c.Path != "/" || c.Domain != "" || c.SameSite != http.SameSiteLaxMode || c.HttpOnly != (i == 0) {
						t.Errorf("cookie policy=%#v", c)
					}
					if clear && (c.MaxAge != -1 || c.Value != "") {
						t.Error("cookie was not cleared")
					}
				}
			}
			for _, c := range []struct {
				name, cookie string
				want         ReadStatus
			}{
				{"absent", "", Absent},
				{"other mode only", otherPrefix + AccessTokenCookieName + "=other; " + otherPrefix + CSRFCookieName + "=other", Absent},
				{"no delivery cookie", prefix + AccessTokenCookieName + "=private-token", Valid},
				{"space before equals", prefix + AccessTokenCookieName + " =private-token", Valid},
				{"spaced session first", prefix + AccessTokenCookieName + " =private-token; " + prefix + AccessTokenCookieName + "=other", Invalid},
				{"spaced session last", prefix + AccessTokenCookieName + "=private-token; " + prefix + AccessTokenCookieName + " =other", Invalid},
				{"spaced delivery first", prefix + AccessTokenCookieName + "=private-token; " + prefix + CSRFCookieName + " =first; " + prefix + CSRFCookieName + "=second", Invalid},
				{"spaced delivery last", prefix + AccessTokenCookieName + "=private-token; " + prefix + CSRFCookieName + "=first; " + prefix + CSRFCookieName + " =second", Invalid},
				{"wrong delivery cookie", prefix + AccessTokenCookieName + "=private-token; " + prefix + CSRFCookieName + "=planted", Valid},
				{"other mode ignored", prefix + AccessTokenCookieName + "=private-token; " + otherPrefix + AccessTokenCookieName + "=other", Valid},
				{"empty session", prefix + AccessTokenCookieName + "=", Invalid},
				{"empty delivery", prefix + AccessTokenCookieName + "=private-token; " + prefix + CSRFCookieName + "=", Invalid},
				{"malformed session", prefix + AccessTokenCookieName + "=bad\\value", Invalid},
				{"invalid duplicate still counts", prefix + AccessTokenCookieName + "=private-token; " + prefix + AccessTokenCookieName + "=bad\\value", Invalid},
			} {
				t.Run(c.name, func(t *testing.T) {
					r := httptest.NewRequest(http.MethodGet, "/", nil)
					r.Header.Set("Cookie", c.cookie)
					values, status := manager.Read(r)
					if status != c.want {
						t.Fatalf("status=%v want=%v", status, c.want)
					}
					if status == Valid && values.AccessToken != "private-token" {
						t.Fatal("read wrong session")
					}
				})
			}
			for _, suffix := range []string{AccessTokenCookieName, CSRFCookieName} {
				for _, separate := range []bool{false, true} {
					for _, duplicate := range []string{"first", "second"} {
						r := httptest.NewRequest(http.MethodGet, "/", nil)
						r.Header.Set("Cookie", prefix+AccessTokenCookieName+"=first; "+prefix+CSRFCookieName+"=first")
						if separate {
							r.Header.Add("Cookie", prefix+suffix+"="+duplicate)
						} else {
							r.Header.Set("Cookie", r.Header.Get("Cookie")+"; "+prefix+suffix+"="+duplicate)
						}
						if _, status := manager.Read(r); status != Invalid {
							t.Errorf("duplicate %s separate=%t accepted", suffix, separate)
						}
					}
				}
			}
		})
	}
}

func TestCSRFUsesStableSessionAndIndependentKey(t *testing.T) {
	key := []byte(testCSRFKey)
	manager, err := NewManager(Config{CSRFKey: key})
	if err != nil {
		t.Fatal(err)
	}
	key[0] ^= 0xff // callers cannot mutate the manager's key after construction.
	for _, row := range []struct{ sid, expected string }{
		{"token-1", testCSRFToken},
		{"token-2", "JM8gOo12BSzaeT7HPA98jWao_tv2tDPbC_iyqj6JfFg"},
		{"token-1", testCSRFToken},
	} {
		w := httptest.NewRecorder()
		value, err := manager.Establish(w, "private-token", row.sid, time.Now().Add(time.Hour))
		if err != nil || value != row.expected || len(value) != 43 || strings.Contains(value, "=") {
			t.Fatalf("derivation=%q err=%v", value, err)
		}
	}
	other, err := NewManager(Config{CSRFKey: key})
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/", nil)
	r.Header.Set(CSRFHeaderName, testCSRFToken)
	if !manager.ValidCSRF(r, "token-1") || manager.ValidCSRF(r, "token-2") || other.ValidCSRF(r, "token-1") {
		t.Fatal("CSRF binding is not exclusive to key/session")
	}
	for _, header := range []http.Header{
		{}, {CSRFHeaderName: {""}}, {CSRFHeaderName: {"planted"}},
		{CSRFHeaderName: {testCSRFToken, testCSRFToken}},
		{CSRFHeaderName: {testCSRFToken + "," + testCSRFToken}},
		{CSRFHeaderName: {testCSRFToken}, "x-antnest-csrf-token": {testCSRFToken}},
	} {
		r.Header = header
		if manager.ValidCSRF(r, "token-1") {
			t.Error("ambiguous or unbound header was accepted")
		}
	}
}

func TestInvalidSessionOrKeyCannotPartiallyEstablishCookies(t *testing.T) {
	for _, size := range []int{0, 1, 31, 33, 64} {
		if _, err := NewManager(Config{CSRFKey: make([]byte, size)}); err == nil {
			t.Errorf("key size %d accepted", size)
		}
	}
	manager, err := NewManager(Config{CSRFKey: []byte(testCSRFKey)})
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range []struct {
		token, sid string
		expiry     time.Time
	}{
		{"token", "", time.Now().Add(time.Hour)},
		{"token", "bad sid", time.Now().Add(time.Hour)},
		{"token", strings.Repeat("x", 201), time.Now().Add(time.Hour)},
		{"", "token-1", time.Now().Add(time.Hour)},
		{"token", "token-1", time.Now().Add(-time.Second)},
	} {
		w := httptest.NewRecorder()
		if _, err := manager.Establish(w, row.token, row.sid, row.expiry); err == nil || len(w.Result().Cookies()) != 0 {
			t.Error("invalid session established cookies")
		}
	}
}
