package scim

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
)

var memberPathPattern = regexp.MustCompile(`(?i)^members\s*\[\s*value\s+eq\s+"([^"]+)"\s*\]$`)

type patchRequest struct {
	Schemas    []string         `json:"schemas"`
	Operations []patchOperation `json:"Operations"`
}

type patchOperation struct {
	Operation string          `json:"op"`
	Path      string          `json:"path"`
	Value     json.RawMessage `json:"value"`
}

func (h *HTTPHandler) patchUser(response http.ResponseWriter, request *http.Request, authorization Authorization) {
	var body patchRequest
	if !decodeSCIMBody(response, request, &body) {
		return
	}
	current, err := h.service.GetUser(request.Context(), authorization, request.PathValue("id"))
	if err != nil {
		writeServiceError(response, err)
		return
	}
	input := UserInput{
		ExternalID: current.Membership.SCIMExternalID, UserName: current.Membership.SCIMUserName,
		DisplayName: current.User.DisplayName, Active: current.User.Active && current.Membership.Active,
	}
	for _, operation := range body.Operations {
		if err := applyUserPatch(&input, operation); err != nil {
			writeSCIMError(response, http.StatusBadRequest, patchErrorType(err), err.Error())
			return
		}
	}
	resource, err := h.service.ReplaceUser(request.Context(), authorization, request.PathValue("id"), input)
	if err != nil {
		writeServiceError(response, err)
		return
	}
	writeSCIM(response, http.StatusOK, h.userResponse(resource))
}

func (h *HTTPHandler) patchGroup(response http.ResponseWriter, request *http.Request, authorization Authorization) {
	var body patchRequest
	if !decodeSCIMBody(response, request, &body) {
		return
	}
	current, err := h.service.GetGroup(request.Context(), authorization, request.PathValue("id"))
	if err != nil {
		writeServiceError(response, err)
		return
	}
	input := GroupInput{
		ExternalID: current.Group.SCIMExternalID, DisplayName: current.Group.DisplayName,
		MemberIDs: append([]string(nil), current.MemberIDs...),
	}
	for _, operation := range body.Operations {
		if err := applyGroupPatch(&input, operation); err != nil {
			writeSCIMError(response, http.StatusBadRequest, patchErrorType(err), err.Error())
			return
		}
	}
	resource, err := h.service.ReplaceGroup(request.Context(), authorization, request.PathValue("id"), input)
	if err != nil {
		writeServiceError(response, err)
		return
	}
	writeSCIM(response, http.StatusOK, h.groupResponse(resource))
}

func applyUserPatch(input *UserInput, operation patchOperation) error {
	op := strings.ToLower(strings.TrimSpace(operation.Operation))
	path := strings.ToLower(strings.TrimSpace(operation.Path))
	if op != "add" && op != "replace" && op != "remove" {
		return fmt.Errorf("unsupported SCIM patch operation %q", operation.Operation)
	}
	if path == "" {
		if op == "remove" {
			return fmt.Errorf("path is required for remove")
		}
		var values map[string]json.RawMessage
		if err := json.Unmarshal(operation.Value, &values); err != nil {
			return invalidPatchValue("patch value must be an object")
		}
		for name, value := range values {
			if err := setUserPatchValue(input, strings.ToLower(name), value, op); err != nil {
				return err
			}
		}
		return nil
	}
	return setUserPatchValue(input, path, operation.Value, op)
}

func setUserPatchValue(input *UserInput, path string, value json.RawMessage, operation string) error {
	switch path {
	case "active":
		if operation == "remove" {
			input.Active = false
			return nil
		}
		if err := json.Unmarshal(value, &input.Active); err != nil {
			return invalidPatchValue("SCIM active patch value must be a boolean")
		}
		return nil
	case "username":
		return patchString(&input.UserName, value, operation)
	case "displayname":
		return patchString(&input.DisplayName, value, operation)
	case "externalid":
		return patchString(&input.ExternalID, value, operation)
	default:
		return fmt.Errorf("unsupported SCIM User patch path %q", path)
	}
}

func applyGroupPatch(input *GroupInput, operation patchOperation) error {
	op := strings.ToLower(strings.TrimSpace(operation.Operation))
	path := strings.TrimSpace(operation.Path)
	lowerPath := strings.ToLower(path)
	if op != "add" && op != "replace" && op != "remove" {
		return fmt.Errorf("unsupported SCIM patch operation %q", operation.Operation)
	}
	if matches := memberPathPattern.FindStringSubmatch(path); len(matches) == 2 {
		if op != "remove" {
			return fmt.Errorf("filtered members path only supports remove")
		}
		input.MemberIDs = removeMember(input.MemberIDs, matches[1])
		return nil
	}
	switch lowerPath {
	case "displayname":
		return patchString(&input.DisplayName, operation.Value, op)
	case "externalid":
		return patchString(&input.ExternalID, operation.Value, op)
	case "members":
		if op == "remove" {
			input.MemberIDs = nil
			return nil
		}
		members, err := decodeMembers(operation.Value)
		if err != nil {
			return err
		}
		if op == "replace" {
			input.MemberIDs = members
		} else {
			input.MemberIDs = append(input.MemberIDs, members...)
		}
		return nil
	case "":
		if op == "remove" {
			return fmt.Errorf("path is required for remove")
		}
		var values map[string]json.RawMessage
		if err := json.Unmarshal(operation.Value, &values); err != nil {
			return invalidPatchValue("patch value must be an object")
		}
		for name, value := range values {
			if err := applyGroupPatch(input, patchOperation{Operation: op, Path: name, Value: value}); err != nil {
				return err
			}
		}
		return nil
	default:
		return fmt.Errorf("unsupported SCIM Group patch path %q", path)
	}
}

func patchString(target *string, value json.RawMessage, operation string) error {
	if operation == "remove" {
		*target = ""
		return nil
	}
	if err := json.Unmarshal(value, target); err != nil {
		return invalidPatchValue("SCIM patch value must be a string")
	}
	return nil
}

func decodeMembers(value json.RawMessage) ([]string, error) {
	var members []groupMember
	if err := json.Unmarshal(value, &members); err != nil {
		var member groupMember
		if singleErr := json.Unmarshal(value, &member); singleErr != nil {
			return nil, invalidPatchValue("SCIM members patch value is invalid")
		}
		members = []groupMember{member}
	}
	result := make([]string, 0, len(members))
	for _, member := range members {
		if strings.TrimSpace(member.Value) == "" {
			return nil, invalidPatchValue("SCIM member value is required")
		}
		result = append(result, member.Value)
	}
	return result, nil
}

type patchValueError struct{ detail string }

func (e *patchValueError) Error() string { return e.detail }

func invalidPatchValue(detail string) error { return &patchValueError{detail: detail} }

func patchErrorType(err error) string {
	var valueError *patchValueError
	if errors.As(err, &valueError) {
		return "invalidValue"
	}
	return "invalidPath"
}

func removeMember(input []string, target string) []string {
	result := input[:0]
	for _, memberID := range input {
		if memberID != target {
			result = append(result, memberID)
		}
	}
	return result
}
