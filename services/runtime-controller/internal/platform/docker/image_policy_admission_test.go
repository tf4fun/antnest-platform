package docker

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

func TestDefaultRuntimeImagePolicyRejectsBeforeDocker(t *testing.T) {
	for _, image := range []string{"alpine:latest", "evil.example/antnest/antnest-runtime:local", "antnest/antnest-runtime-extra:local", "antnest/antnest-runtime.evil:local", "antnest/antnest-runtime:local@sha256:" + strings.Repeat("a", 64), "sha256:" + strings.Repeat("a", 64)} {
		t.Run(image, func(t *testing.T) {
			calls := 0
			client, err := NewHTTPClient(&http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				calls++
				return jsonResponse(http.StatusOK, map[string]any{"Id": "sha256:" + strings.Repeat("b", 64)}), nil
			})}, "http://docker")
			if err != nil {
				t.Fatal(err)
			}
			driver, err := NewDriver(client, Config{ControllerScope: "test", ManagementNetwork: "management", SystemSkillsVolume: "skills"})
			if err != nil {
				t.Fatal(err)
			}
			_, err = driver.ResolveImage(context.Background(), image)
			if err == nil || !strings.Contains(err.Error(), "not allowed") || calls != 0 {
				t.Fatalf("image policy bypass: error=%v Docker requests=%d", err, calls)
			}
		})
	}
}
