package domain

import (
	"crypto/sha256"
	"encoding/hex"
)

// DeriveResourceID keeps the resource kind independent of the operation's
// retry namespace. The same namespace and key always identify the same record.
func DeriveResourceID(kind, namespace, key string) string {
	digest := sha256.Sum256([]byte(namespace + "\x00" + key))
	return kind + "_" + hex.EncodeToString(digest[:16])
}
