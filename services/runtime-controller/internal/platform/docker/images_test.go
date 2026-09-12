package docker

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"soft/antnest-platform/services/runtime-controller/internal/platform"
)

func TestResolveImageInspectsTaggedReferenceWithoutPulling(t *testing.T) {
	imageID := "sha256:" + strings.Repeat("a", 64)
	var requests []string
	client, err := NewHTTPClient(&http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests = append(requests, request.Method+" "+request.URL.Path)
		return jsonResponse(http.StatusOK, map[string]any{
			"Id": imageID, "RepoDigests": []string{},
			"Config": map[string]any{"Env": []string{"SECRET=must-not-leave-adapter"}},
		}), nil
	})}, "http://docker")
	if err != nil {
		t.Fatal(err)
	}
	driver, err := NewDriver(client, Config{ControllerScope: "test", ManagementNetwork: "management", SystemSkillsVolume: "skills"})
	if err != nil {
		t.Fatal(err)
	}
	result, err := driver.ResolveImage(context.Background(), "registry.example.com:5000/team/runtime:v1")
	if err != nil || result.Reference != "registry.example.com:5000/team/runtime:v1" || result.ImageRef != imageID {
		t.Fatalf("resolution = %+v, error = %v", result, err)
	}
	if len(requests) != 1 || requests[0] != "GET /v1.47/images/registry.example.com:5000/team/runtime:v1/json" {
		t.Fatalf("resolution must only inspect the selected image: %v", requests)
	}
	for _, reference := range []string{"runtime", imageID, "repo/runtime:v1@" + imageID} {
		result, err := driver.ResolveImage(context.Background(), reference)
		if err != nil || result.Reference != reference || result.ImageRef != imageID {
			t.Fatalf("resolve %q: %+v %v", reference, result, err)
		}
	}
}

func TestResolveImageRejectsInvalidChoicesBeforePlatformAccess(t *testing.T) {
	client, err := NewHTTPClient(&http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("invalid image reference reached Docker")
		return nil, errors.New("unexpected Docker call")
	})}, "http://docker")
	if err != nil {
		t.Fatal(err)
	}
	driver, err := NewDriver(client, Config{ControllerScope: "test", ManagementNetwork: "management", SystemSkillsVolume: "skills"})
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{
		"", " runtime ", "https://registry.example.com/runtime:v1", "repo/UPPER:v1", "repo/runtime:v1?key=secret",
		"repo/runtime:" + strings.Repeat("a", 513),
	} {
		t.Run(value, func(t *testing.T) {
			if _, err := driver.ResolveImage(context.Background(), value); !errors.Is(err, platform.ErrInvalidImageReference) {
				t.Fatalf("error = %v, want invalid image reference", err)
			}
		})
	}
}

func TestResolveImageMapsMissingMalformedAndUnavailableImages(t *testing.T) {
	for _, test := range []struct {
		name   string
		status int
		id     string
		cause  error
		want   error
	}{
		{name: "missing", status: http.StatusNotFound, want: platform.ErrImageNotFound},
		{name: "malformed identity", status: http.StatusOK, id: "mutable:tag", want: platform.ErrImageResolutionUnavailable},
		{name: "platform unavailable", status: http.StatusInternalServerError, want: platform.ErrImageResolutionUnavailable},
		{name: "timeout", cause: context.DeadlineExceeded, want: context.DeadlineExceeded},
	} {
		t.Run(test.name, func(t *testing.T) {
			client, err := NewHTTPClient(&http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				if test.cause != nil {
					return nil, test.cause
				}
				return jsonResponse(test.status, map[string]string{"Id": test.id}), nil
			})}, "http://docker")
			if err != nil {
				t.Fatal(err)
			}
			driver, err := NewDriver(client, Config{ControllerScope: "test", ManagementNetwork: "management", SystemSkillsVolume: "skills"})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := driver.ResolveImage(context.Background(), "antnest/runtime:local"); !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
		})
	}
}
