package docker

import (
	"fmt"
	"strings"

	"github.com/distribution/reference"
	"github.com/opencontainers/go-digest"
)

// ImagePolicy is configured by the operator, never by lifecycle request bodies.
// Repositories permit their tags/digests; repository@sha256 pins one manifest.
type ImagePolicy struct {
	repositories map[string]bool
	manifests    map[string]bool
}

func ParseImagePolicy(entries []string) (*ImagePolicy, error) {
	if len(entries) == 0 {
		entries = []string{"antnest/antnest-runtime"}
	}
	result := &ImagePolicy{repositories: map[string]bool{}, manifests: map[string]bool{}}
	for _, entry := range entries {
		named, err := reference.ParseNormalizedNamed(entry)
		if err != nil || len(entry) > 512 || entry == "" || strings.TrimSpace(entry) != entry {
			return nil, fmt.Errorf("allowed image must be a repository or repository@sha256 digest")
		}
		if _, tagged := named.(reference.Tagged); tagged {
			return nil, fmt.Errorf("allowed image tags and wildcard patterns are not supported")
		}
		name := reference.TrimNamed(named).Name()
		if pinned, ok := named.(reference.Canonical); ok {
			if pinned.Digest().Algorithm() != digest.SHA256 {
				return nil, fmt.Errorf("allowed image digest must use sha256")
			}
			key := name + "@" + pinned.Digest().String()
			if result.manifests[key] {
				return nil, fmt.Errorf("duplicate allowed image")
			}
			result.manifests[key] = true
		} else {
			if result.repositories[name] {
				return nil, fmt.Errorf("duplicate allowed image")
			}
			result.repositories[name] = true
		}
	}
	return result, nil
}

func (p *ImagePolicy) Allows(raw string) bool {
	// Docker accepts a bare digest as a local image ID. Even when an operator
	// permits a repository named "sha256", that spelling must not authorize IDs.
	if _, err := digest.Parse(raw); err == nil {
		return false
	}
	named, err := reference.ParseNormalizedNamed(raw)
	if p == nil || err != nil || raw == "" || len(raw) > 512 || strings.TrimSpace(raw) != raw {
		return false
	}
	_, tagged := named.(reference.Tagged)
	canonical, pinned := named.(reference.Canonical)
	if tagged && pinned {
		return false
	}
	name := reference.TrimNamed(named).Name()
	if pinned && canonical.Digest().Algorithm() != digest.SHA256 {
		return false
	}
	if p.repositories[name] {
		return true
	}
	return pinned && p.manifests[name+"@"+canonical.Digest().String()]
}
