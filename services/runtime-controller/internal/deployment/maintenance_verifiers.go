package deployment

import (
	"encoding/base64"
	"regexp"
	"slices"
)

var maintenanceKID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)

type MaintenanceVerifierKey struct {
	KID                string `json:"kid"`
	Algorithm          string `json:"algorithm"`
	PublicKeyBase64URL string `json:"public_key_base64url"`
}

type MaintenanceVerifiers struct {
	Keys []MaintenanceVerifierKey `json:"keys"`
}

func (v MaintenanceVerifiers) Normalize() (MaintenanceVerifiers, error) {
	if len(v.Keys) > 2 {
		return MaintenanceVerifiers{}, invalid("skill_maintenance_verifiers allows at most two keys")
	}
	keys := slices.Clone(v.Keys)
	for _, key := range keys {
		if !maintenanceKID.MatchString(key.KID) {
			return MaintenanceVerifiers{}, invalid("skill_maintenance_verifiers kid is invalid")
		}
		if key.Algorithm != "Ed25519" {
			return MaintenanceVerifiers{}, invalid("skill_maintenance_verifiers algorithm is unsupported")
		}
		bytes, err := base64.RawURLEncoding.Strict().DecodeString(key.PublicKeyBase64URL)
		if err != nil || len(bytes) != 32 || base64.RawURLEncoding.EncodeToString(bytes) != key.PublicKeyBase64URL {
			return MaintenanceVerifiers{}, invalid("skill_maintenance_verifiers public key is invalid")
		}
	}
	slices.SortFunc(keys, func(a, b MaintenanceVerifierKey) int {
		if a.KID < b.KID {
			return -1
		}
		if a.KID > b.KID {
			return 1
		}
		return 0
	})
	if len(keys) == 2 && keys[0].KID == keys[1].KID {
		return MaintenanceVerifiers{}, invalid("skill_maintenance_verifiers has duplicate kid")
	}
	if keys == nil {
		keys = []MaintenanceVerifierKey{}
	}
	return MaintenanceVerifiers{Keys: keys}, nil
}

func (v MaintenanceVerifiers) Clone() MaintenanceVerifiers {
	return MaintenanceVerifiers{Keys: slices.Clone(v.Keys)}
}
