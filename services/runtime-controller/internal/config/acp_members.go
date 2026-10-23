package config

import (
	"errors"
	"io"
	"os"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/acpincarnation"
)

func loadACPMembers(path string) (members []acpincarnation.Member, resultErr error) {
	if path == "" {
		return []acpincarnation.Member{}, nil
	}
	invalid := errors.New("ANTNEST_RUNTIME_ACP_MEMBERS_FILE must contain a readable regular member catalog")
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return nil, invalid
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, invalid
	}
	defer func() {
		if err := file.Close(); err != nil {
			members = nil
			resultErr = invalid
		}
	}()
	info, err = file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil, invalid
	}
	const maxBytes = 64 << 10
	raw, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil || len(raw) > maxBytes {
		return nil, invalid
	}
	var catalog struct {
		Version int `json:"version"`
		Members []struct {
			ID       string `json:"member_id"`
			Selector string `json:"container_selector"`
			Network  string `json:"network"`
			Origin   string `json:"probe_origin"`
		} `json:"members"`
	}
	if err := serviceauth.DecodeObject(raw, &catalog); err != nil || catalog.Version != 1 || catalog.Members == nil || len(catalog.Members) > 128 {
		return nil, invalid
	}
	members = make([]acpincarnation.Member, len(catalog.Members))
	for index, member := range catalog.Members {
		members[index] = acpincarnation.Member{ID: member.ID, Selector: member.Selector, Network: member.Network, Origin: member.Origin}
	}
	if err := acpincarnation.ValidateMembers(members); err != nil {
		return nil, invalid
	}
	return members, nil
}
