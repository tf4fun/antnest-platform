package rpc

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/observation"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/platform"
)

type imageService struct {
	*fakeService
	resolve func(context.Context, string) (platform.ImageResolution, error)
}

func (s imageService) ResolveImage(ctx context.Context, reference string) (platform.ImageResolution, error) {
	return s.resolve(ctx, reference)
}

func TestResolveImageRPCIsReadOnlyAndDoesNotRequireLifecycleIdentity(t *testing.T) {
	want := map[string]string{"reference": "registry.example.com:5000/team/runtime:v1", "image_ref": "sha256:" + strings.Repeat("a", 64)}
	service := imageService{fakeService: &fakeService{}, resolve: func(ctx context.Context, reference string) (platform.ImageResolution, error) {
		if reference != want["reference"] {
			t.Fatalf("reference=%q", reference)
		}
		if _, ok := ctx.Deadline(); !ok {
			t.Fatal("image lookup has no bounded deadline")
		}
		return platform.ImageResolution{Reference: want["reference"], ImageRef: want["image_ref"]}, nil
	}}
	handler, err := NewHandler(service, observation.NewHub(), time.Second, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/internal/runtime-images/resolve?reference="+url.QueryEscape(want["reference"]), nil))
	var actual map[string]string
	if err := json.Unmarshal(response.Body.Bytes(), &actual); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusOK || len(actual) != len(want) || actual["reference"] != want["reference"] || actual["image_ref"] != want["image_ref"] {
		t.Fatalf("response=%d %s", response.Code, response.Body)
	}
	if service.initializeCalls != 0 || service.command != "" {
		t.Fatal("image lookup invoked a lifecycle mutation")
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("mutable tag resolution must not be cached by an HTTP intermediary")
	}
}

func TestResolveImageRPCRejectsMalformedQueriesBeforeService(t *testing.T) {
	service := imageService{fakeService: &fakeService{}, resolve: func(context.Context, string) (platform.ImageResolution, error) {
		t.Fatal("invalid query reached the service")
		return platform.ImageResolution{}, nil
	}}
	handler, err := NewHandler(service, observation.NewHub(), time.Second, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{"", "reference=", "reference=a:v1&reference=b:v1", "reference=a:v1&pull=true", "reference=a:v1&agent_id=one"} {
		t.Run(query, func(t *testing.T) {
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/internal/runtime-images/resolve?"+query, nil))
			if response.Code != http.StatusBadRequest {
				t.Fatalf("response=%d %s", response.Code, response.Body)
			}
		})
	}
}

func TestResolveImageRPCHidesPlatformDetailsAndMapsFailures(t *testing.T) {
	for _, test := range []struct {
		cause  error
		status int
		code   string
	}{
		{platform.ErrInvalidImageReference, 400, "invalid_request"},
		{platform.ErrImageNotFound, 404, "image_not_found"},
		{platform.ErrImageResolutionUnavailable, 503, "platform_unavailable"},
		{context.DeadlineExceeded, 504, "deadline_exceeded"},
		{errors.Join(platform.ErrImageResolutionUnavailable, context.DeadlineExceeded), 504, "deadline_exceeded"},
	} {
		t.Run(test.code, func(t *testing.T) {
			service := imageService{fakeService: &fakeService{}, resolve: func(context.Context, string) (platform.ImageResolution, error) {
				return platform.ImageResolution{}, errors.Join(test.cause, errors.New("private platform diagnostics"))
			}}
			handler, err := NewHandler(service, observation.NewHub(), time.Second, time.Second)
			if err != nil {
				t.Fatal(err)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/internal/runtime-images/resolve?reference=runtime:v1", nil))
			var body errorResponse
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if response.Code != test.status || body.Code != test.code || strings.Contains(response.Body.String(), "private platform") {
				t.Fatalf("response=%d %s", response.Code, response.Body)
			}
		})
	}
}

func TestLifecycleUsesSameImageErrorClassification(t *testing.T) {
	descriptor := classifyError(platform.ErrImageNotFound)
	if descriptor.status != http.StatusNotFound || descriptor.response.Code != "image_not_found" || descriptor.response.Retryable {
		t.Fatalf("missing build image became retryable internal failure: %+v", descriptor)
	}
}
