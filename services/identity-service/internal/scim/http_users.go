package scim

import (
	"fmt"
	"net/http"
	"strings"
)

type userRequest struct {
	Schemas     []string `json:"schemas"`
	ExternalID  string   `json:"externalId"`
	UserName    string   `json:"userName"`
	DisplayName string   `json:"displayName"`
	Name        struct {
		Formatted string `json:"formatted"`
	} `json:"name"`
	Emails []userEmail `json:"emails"`
	Active *bool       `json:"active"`
}

type userEmail struct {
	Value   string `json:"value"`
	Type    string `json:"type"`
	Primary bool   `json:"primary"`
}

func (h *HTTPHandler) listUsers(response http.ResponseWriter, request *http.Request, authorization Authorization) {
	query, err := listQueryFromRequest(request)
	if err != nil {
		writeListQueryError(response, err)
		return
	}
	if query.FilterAttribute != "" && !equalFoldAny(query.FilterAttribute, "userName", "externalId", "emails.value") {
		writeSCIMError(response, http.StatusBadRequest, "invalidFilter", "Unsupported SCIM User filter")
		return
	}
	page, err := h.service.ListUsers(request.Context(), authorization, query)
	if err != nil {
		writeServiceError(response, err)
		return
	}
	resources := make([]map[string]any, 0, len(page.Items))
	for _, item := range page.Items {
		resources = append(resources, h.userResponse(item))
	}
	writeSCIM(response, http.StatusOK, listResponse(resources, page.TotalResults, query.StartIndex))
}

func (h *HTTPHandler) createUser(response http.ResponseWriter, request *http.Request, authorization Authorization) {
	var body userRequest
	if !decodeSCIMBody(response, request, &body) {
		return
	}
	if err := validateSchemas(body.Schemas, userSchema); err != nil {
		writeSCIMError(response, http.StatusBadRequest, "invalidValue", err.Error())
		return
	}
	input, err := body.input()
	if err != nil {
		writeSCIMError(response, http.StatusBadRequest, "invalidValue", err.Error())
		return
	}
	resource, err := h.service.CreateUser(request.Context(), authorization, input)
	if err != nil {
		writeServiceError(response, err)
		return
	}
	response.Header().Set("Location", h.location("Users", resource.Membership.ID))
	writeSCIM(response, http.StatusCreated, h.userResponse(resource))
}

func (h *HTTPHandler) getUser(response http.ResponseWriter, request *http.Request, authorization Authorization) {
	resource, err := h.service.GetUser(request.Context(), authorization, request.PathValue("id"))
	if err != nil {
		writeServiceError(response, err)
		return
	}
	writeSCIM(response, http.StatusOK, h.userResponse(resource))
}

func (h *HTTPHandler) replaceUser(response http.ResponseWriter, request *http.Request, authorization Authorization) {
	var body userRequest
	if !decodeSCIMBody(response, request, &body) {
		return
	}
	if err := validateSchemas(body.Schemas, userSchema); err != nil {
		writeSCIMError(response, http.StatusBadRequest, "invalidValue", err.Error())
		return
	}
	input, err := body.input()
	if err != nil {
		writeSCIMError(response, http.StatusBadRequest, "invalidValue", err.Error())
		return
	}
	resource, err := h.service.ReplaceUser(
		request.Context(), authorization, request.PathValue("id"), ReplaceUserInput{UserInput: input},
	)
	if err != nil {
		writeServiceError(response, err)
		return
	}
	writeSCIM(response, http.StatusOK, h.userResponse(resource))
}

func (h *HTTPHandler) deleteUser(response http.ResponseWriter, request *http.Request, authorization Authorization) {
	if err := h.service.DeleteUser(request.Context(), authorization, request.PathValue("id")); err != nil {
		writeServiceError(response, err)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func (b userRequest) input() (UserInput, error) {
	active := true
	if b.Active != nil {
		active = *b.Active
	}
	email, err := b.primaryEmail()
	if err != nil {
		return UserInput{}, err
	}
	displayName := strings.TrimSpace(b.DisplayName)
	if displayName == "" {
		displayName = strings.TrimSpace(b.Name.Formatted)
	}
	return UserInput{
		ExternalID: strings.TrimSpace(b.ExternalID), UserName: b.UserName,
		Email: email, DisplayName: displayName, Active: active,
	}, nil
}

func (b userRequest) primaryEmail() (string, error) {
	selected := ""
	primaryCount := 0
	for _, email := range b.Emails {
		value := strings.TrimSpace(email.Value)
		if value == "" {
			continue
		}
		if selected == "" {
			selected = value
		}
		if email.Primary {
			primaryCount++
			selected = value
		}
	}
	if primaryCount > 1 {
		return "", fmt.Errorf("SCIM User must not contain more than one primary email")
	}
	if selected == "" {
		selected = strings.TrimSpace(b.UserName)
	}
	return selected, nil
}

func (h *HTTPHandler) userResponse(resource UserResource) map[string]any {
	active := resource.User.Active && resource.Membership.Active
	return map[string]any{
		"schemas": []string{userSchema}, "id": resource.Membership.ID,
		"externalId":  resource.Membership.SCIMExternalID,
		"userName":    resource.Membership.SCIMUserName,
		"displayName": resource.Membership.DisplayName, "active": active,
		"name":   map[string]any{"formatted": resource.Membership.DisplayName},
		"emails": []map[string]any{{"value": resource.Membership.Email, "primary": true}},
		"meta": map[string]any{
			"resourceType": "User", "created": resource.Membership.CreatedAt,
			"lastModified": resource.Membership.UpdatedAt,
			"location":     h.location("Users", resource.Membership.ID),
		},
	}
}
