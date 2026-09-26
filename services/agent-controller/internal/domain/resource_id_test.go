package domain

import "testing"

func TestDerivedResourceIDsKeepKindsSeparateFromRetryNamespaces(t *testing.T) {
	for _, test := range []struct{ kind, namespace, key, want string }{
		{"agent", "agent", "request-create-agent", "agent_e94c17c429dc4904d167d643309872e5"},
		{"agentspec", "agentspec-rebuild", "request-rebuild-agent", "agentspec_88aeefd8600950cfc87788cc5e0d1e71"},
		{"accessrev", "access-rebuild", "request-rebuild-agent", "accessrev_82213c596dc8a9ff57b38c7e295525ad"},
		{"event", "event-created", "request-create-agent", "event_2952d9613148547f71475a6556b61e83"},
		{"event", "event-rebuilt", "request-rebuild-agent", "event_15a90cd203b97050aeaa0e4178733fc7"},
		{"execution", "execution-observed", "create-1", "execution_8e82730e0186ecc2a071c2f0c4c4b92c"},
	} {
		if got := DeriveResourceID(test.kind, test.namespace, test.key); got != test.want {
			t.Errorf("%s/%s = %q, want %q", test.kind, test.namespace, got, test.want)
		}
		if got := DeriveResourceID(test.kind, test.namespace, test.key+"-other"); got == test.want {
			t.Errorf("%s reused identity for a different retry key", test.namespace)
		}
	}
}
