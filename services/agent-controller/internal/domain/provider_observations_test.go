package domain

import "testing"

func TestCanonicalProviderBaseURLNormalizationAndEquivalence(t *testing.T) {
	for _, scenario := range []struct {
		name  string
		input string
		want  string
	}{
		{"case and default port", "HTTPS://API.EXAMPLE.COM:443", "https://api.example.com/"},
		{"http default port", "http://EXAMPLE.com:80/v1", "http://example.com/v1"},
		{"trailing slashes collapsed", "https://a.example/v1///", "https://a.example/v1"},
		{"root stays root", "https://a.example/", "https://a.example/"},
		{"nondefault port kept", "https://a.example:8443/v1", "https://a.example:8443/v1"},
		{"public IPv6 plain", "https://[2001:db8::1]/v1", "https://[2001:db8::1]/v1"},
		{"public IPv6 default port", "https://[2001:DB8::1]:443/v1/", "https://[2001:db8::1]/v1"},
		{"public IPv6 custom port", "https://[2001:db8::1]:8443", "https://[2001:db8::1]:8443/"},
		{"escaped path preserved", "https://a.example/v1%20x%2Fy", "https://a.example/v1%20x%2Fy"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			got, err := CanonicalProviderBaseURL(scenario.input)
			if err != nil || got != scenario.want {
				t.Fatalf("canonical(%q)=%q,%v want %q", scenario.input, got, err, scenario.want)
			}
		})
	}
}

func TestCanonicalProviderBaseURLEquivalenceAndEscapedDistinction(t *testing.T) {
	equivalents := [][2]string{
		{"https://api.example.com", "https://api.example.com/"},
		{"https://api.example.com:443/v1/", "https://API.EXAMPLE.COM/v1"},
		{"https://api.example.com/v1/", "https://api.example.com/v1"},
	}
	for _, pair := range equivalents {
		first, err := CanonicalProviderBaseURL(pair[0])
		second, err2 := CanonicalProviderBaseURL(pair[1])
		if err != nil || err2 != nil || first != second {
			t.Fatalf("equivalent URLs canonicalize differently: %q=%q %q=%q", pair[0], first, pair[1], second)
		}
	}
	escapedA, _ := CanonicalProviderBaseURL("https://a.example/v1%2Fx")
	escapedB, _ := CanonicalProviderBaseURL("https://a.example/v1/x")
	if escapedA != "https://a.example/v1%2Fx" || escapedA == escapedB {
		t.Fatalf("escaped path must be preserved and distinct: %q vs %q", escapedA, escapedB)
	}
}

func TestCanonicalProviderBaseURLRejectsMalformed(t *testing.T) {
	for _, input := range []string{
		"", "not a url", "ftp://a.example", "mailto:a@b.example", "https://a.example?x=1",
		"https://a.example#frag", "https://u:p@a.example", "https://a.example:0", "https://a.example:99999",
		"https://a.example:bad", "//a.example", "https://",
	} {
		if got, err := CanonicalProviderBaseURL(input); err == nil {
			t.Fatalf("malformed URL %q canonicalized to %q", input, got)
		}
	}
}

func TestProviderObservationSetValidation(t *testing.T) {
	valid := ProviderObservationSet{
		Binding: ProviderObservationBinding{OrganizationID: "org-1", ConnectionID: "conn-1", ProviderKey: "deepseek",
			RequestProtocol: "openai_chat_completions", BaseURL: "https://api.example.com/", CredentialRevision: "version-1"},
		SourceRevision: 1,
		Models:         []ProviderObservedModel{{Model: "model"}},
	}
	if !valid.ValidObservationSet() {
		t.Fatal("valid set rejected")
	}
	for _, scenario := range []struct {
		name   string
		mutate func(*ProviderObservationSet)
	}{
		{"noncanonical URL", func(s *ProviderObservationSet) { s.Binding.BaseURL = "https://api.example.com:443" }},
		{"unsupported provider", func(s *ProviderObservationSet) { s.Binding.ProviderKey = "openai_compatible" }},
		{"wrong protocol", func(s *ProviderObservationSet) { s.Binding.RequestProtocol = "other" }},
		{"bad org grammar", func(s *ProviderObservationSet) { s.Binding.OrganizationID = "org/1" }},
		{"bad credential grammar", func(s *ProviderObservationSet) { s.Binding.CredentialRevision = "ver sion" }},
		{"duplicate model ids", func(s *ProviderObservationSet) { s.Models = append(s.Models, ProviderObservedModel{Model: "model"}) }},
		{"blank model", func(s *ProviderObservationSet) { s.Models = []ProviderObservedModel{{Model: "  "}} }},
		{"nil models", func(s *ProviderObservationSet) { s.Models = nil }},
		{"unsafe dim", func(s *ProviderObservationSet) { over := MaximumSafeInteger + 1; s.Models[0].ContextTokens = &over }},
		{"zero revision", func(s *ProviderObservationSet) { s.SourceRevision = 0 }},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			set := valid
			set.Models = []ProviderObservedModel{valid.Models[0]}
			scenario.mutate(&set)
			if set.ValidObservationSet() {
				t.Fatal("invalid set accepted")
			}
		})
	}
	// " model" and "model" stay distinct API ids.
	set := valid
	set.Models = []ProviderObservedModel{{Model: "model"}, {Model: " model"}}
	if !set.ValidObservationSet() {
		t.Fatal("distinct whitespace-variant API ids must stay distinct")
	}
}

func TestDecodeObservationModelsFailsClosed(t *testing.T) {
	for _, payload := range []string{
		`null`, `{"model":"x"}`, `[{"model":"m","extra":1}]`, `[{"model":"m"}] trailing`,
		`[{"model":"m","context_tokens":"5"}]`,
	} {
		if models, err := DecodeObservationModels([]byte(payload)); err == nil {
			t.Fatalf("strict decode accepted %q: %+v", payload, models)
		}
	}
	models, err := DecodeObservationModels([]byte(`[{"model":"m","context_tokens":5,"supports_tools":false}]`))
	if err != nil || len(models) != 1 || *models[0].ContextTokens != 5 || *models[0].SupportsTools {
		t.Fatalf("valid payload rejected: %v %+v", err, models)
	}
}
