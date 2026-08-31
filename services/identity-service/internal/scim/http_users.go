package scim

import (
	"net/http"
	"strings"
)

type userRequest struct {
	Schemas     []string `json:"schemas"`
	ExternalID  string   `json:"externalId"`
	UserName    string   `json:"userName"`
	DisplayName string   `json:"displayName"`
	Active      *bool    `json:"active"`
}

func (h *HTTPHandler) listUsers(response http.ResponseWriter, request *http.Request, authorization Authorization) {
	query, err := listQueryFromRequest(request)
	if err != nil {
		writeSCIMError(response, http.StatusBadRequest, "invalidFilter", err.Error())
		return
	}
	if query.FilterAttribute != "" && !equalFoldAny(query.FilterAttribute, "userName", "externalId") {
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
	resource, err := h.service.CreateUser(request.Context(), authorization, body.input())
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
	resource, err := h.service.ReplaceUser(request.Context(), authorization, request.PathValue("id"), body.input())
	if err != nil {
		writeServiceError(response, err)
		return
	}
	writeSCIM(response, http.StatusOK, h.userResponse(resource))
}

func (h *HTTPHandler) deleteUser(response http.ResponseWriter, request *http.Request, authorization Authorization) {
	if _, err := h.service.DeactivateUser(request.Context(), authorization, request.PathValue("id")); err != nil {
		writeServiceError(response, err)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func (b userRequest) input() UserInput {
	active := true
	if b.Active != nil {
		active = *b.Active
	}
	return UserInput{
		ExternalID: strings.TrimSpace(b.ExternalID), UserName: b.UserName,
		DisplayName: b.DisplayName, Active: active,
	}
}

func (h *HTTPHandler) userResponse(resource UserResource) map[string]any {
	active := resource.User.Active && resource.Membership.Active
	return map[string]any{
		"schemas": []string{userSchema}, "id": resource.Membership.ID,
		"externalId":  resource.Membership.SCIMExternalID,
		"userName":    resource.Membership.SCIMUserName,
		"displayName": resource.User.DisplayName, "active": active,
		"emails": []map[string]any{{"value": resource.User.Email, "primary": true}},
		"meta": map[string]any{
			"resourceType": "User", "created": resource.Membership.CreatedAt,
			"lastModified": resource.Membership.UpdatedAt,
			"location":     h.location("Users", resource.Membership.ID),
		},
	}
}
