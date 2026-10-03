package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestModelProfileNativeInputFlagsAtHTTPBoundary(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name   string
		fields string
		status int
		want   bool
	}{
		{name: "omitted", status: http.StatusCreated},
		{name: "enabled", fields: `,"supports_audio":true,"supports_pdf":true`, status: http.StatusCreated, want: true},
		{name: "disabled", fields: `,"supports_audio":false,"supports_pdf":false`, status: http.StatusCreated},
		{name: "invalid audio", fields: `,"supports_audio":"yes"`, status: http.StatusBadRequest},
		{name: "invalid pdf", fields: `,"supports_pdf":1`, status: http.StatusBadRequest},
		{name: "unknown flag", fields: `,"supports_video":true`, status: http.StatusBadRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			catalog := &catalogServiceStub{modelView: sampleModelProfileView()}
			boundary, err := newBusinessHandler(t, catalog, &lifecycleServiceStub{}, &agentConfigurationServiceStub{},
				&agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{},
				func(context.Context) error { return nil })

			if err != nil {
				t.Fatal(err)
			}
			body := `{"request_id":"native-input","organization_id":"org-1","profile_key":"custom",
				"display_name":"Custom","model":{"model":"native",
				"context_window":8192,"max_output_tokens":1024,"supports_images":false` + tc.fields + `},
				"provider_connection_id":"provider-1"}`
			response := httptest.NewRecorder()
			boundary.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/internal/model-profiles", strings.NewReader(body)))
			if response.Code != tc.status {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if tc.status != http.StatusCreated {
				if catalog.createModelInput.RequestID != "" {
					t.Fatal("invalid model reached application")
				}
				return
			}
			model := catalog.createModelInput.Model
			if model.SupportsAudio != tc.want || model.SupportsPDF != tc.want {
				t.Fatalf("native capabilities lost at HTTP boundary: %+v", model)
			}
		})
	}
}
