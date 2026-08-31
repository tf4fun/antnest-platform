package scim

import (
	"net/http"
	"strings"
)

type groupRequest struct {
	Schemas     []string      `json:"schemas"`
	ExternalID  string        `json:"externalId"`
	DisplayName string        `json:"displayName"`
	Members     []groupMember `json:"members"`
}

type groupMember struct {
	Value string `json:"value"`
}

func (h *HTTPHandler) listGroups(response http.ResponseWriter, request *http.Request, authorization Authorization) {
	query, err := listQueryFromRequest(request)
	if err != nil {
		writeSCIMError(response, http.StatusBadRequest, "invalidFilter", err.Error())
		return
	}
	if query.FilterAttribute != "" && !equalFoldAny(query.FilterAttribute, "displayName", "externalId") {
		writeSCIMError(response, http.StatusBadRequest, "invalidFilter", "Unsupported SCIM Group filter")
		return
	}
	page, err := h.service.ListGroups(request.Context(), authorization, query)
	if err != nil {
		writeServiceError(response, err)
		return
	}
	resources := make([]map[string]any, 0, len(page.Items))
	for _, item := range page.Items {
		resources = append(resources, h.groupResponse(item))
	}
	writeSCIM(response, http.StatusOK, listResponse(resources, page.TotalResults, query.StartIndex))
}

func (h *HTTPHandler) createGroup(response http.ResponseWriter, request *http.Request, authorization Authorization) {
	var body groupRequest
	if !decodeSCIMBody(response, request, &body) {
		return
	}
	resource, err := h.service.CreateGroup(request.Context(), authorization, body.input())
	if err != nil {
		writeServiceError(response, err)
		return
	}
	response.Header().Set("Location", h.location("Groups", resource.Group.ID))
	writeSCIM(response, http.StatusCreated, h.groupResponse(resource))
}

func (h *HTTPHandler) getGroup(response http.ResponseWriter, request *http.Request, authorization Authorization) {
	resource, err := h.service.GetGroup(request.Context(), authorization, request.PathValue("id"))
	if err != nil {
		writeServiceError(response, err)
		return
	}
	writeSCIM(response, http.StatusOK, h.groupResponse(resource))
}

func (h *HTTPHandler) replaceGroup(response http.ResponseWriter, request *http.Request, authorization Authorization) {
	var body groupRequest
	if !decodeSCIMBody(response, request, &body) {
		return
	}
	resource, err := h.service.ReplaceGroup(request.Context(), authorization, request.PathValue("id"), body.input())
	if err != nil {
		writeServiceError(response, err)
		return
	}
	writeSCIM(response, http.StatusOK, h.groupResponse(resource))
}

func (h *HTTPHandler) deleteGroup(response http.ResponseWriter, request *http.Request, authorization Authorization) {
	if err := h.service.DeleteGroup(request.Context(), authorization, request.PathValue("id")); err != nil {
		writeServiceError(response, err)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func (b groupRequest) input() GroupInput {
	members := make([]string, 0, len(b.Members))
	for _, member := range b.Members {
		members = append(members, member.Value)
	}
	return GroupInput{
		ExternalID: strings.TrimSpace(b.ExternalID), DisplayName: b.DisplayName,
		MemberIDs: members,
	}
}

func (h *HTTPHandler) groupResponse(resource GroupResource) map[string]any {
	members := make([]map[string]any, 0, len(resource.MemberIDs))
	for _, memberID := range resource.MemberIDs {
		members = append(members, map[string]any{
			"value": memberID, "$ref": h.location("Users", memberID),
		})
	}
	return map[string]any{
		"schemas": []string{groupSchema}, "id": resource.Group.ID,
		"externalId": resource.Group.SCIMExternalID, "displayName": resource.Group.DisplayName,
		"members": members,
		"meta": map[string]any{
			"resourceType": "Group", "created": resource.Group.CreatedAt,
			"lastModified": resource.Group.UpdatedAt,
			"location":     h.location("Groups", resource.Group.ID),
		},
	}
}
