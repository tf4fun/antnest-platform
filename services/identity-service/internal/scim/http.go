package scim

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"soft/antnest-platform/services/identity-service/internal/domain"
)

const (
	userSchema         = "urn:ietf:params:scim:schemas:core:2.0:User"
	groupSchema        = "urn:ietf:params:scim:schemas:core:2.0:Group"
	listResponseSchema = "urn:ietf:params:scim:api:messages:2.0:ListResponse"
	patchSchema        = "urn:ietf:params:scim:api:messages:2.0:PatchOp"
	errorSchema        = "urn:ietf:params:scim:api:messages:2.0:Error"
	maxSCIMBody        = 1 << 20
)

var eqFilterPattern = regexp.MustCompile(`(?i)^\s*([a-z][a-z0-9.]*)\s+eq\s+"([^"]*)"\s*$`)

type HTTPHandler struct {
	service *Service
	baseURL string
	mux     *http.ServeMux
}

func NewHTTPHandler(service *Service, publicBaseURL string) (*HTTPHandler, error) {
	if service == nil {
		return nil, fmt.Errorf("SCIM HTTP handler requires service")
	}
	parsed, err := url.Parse(strings.TrimRight(strings.TrimSpace(publicBaseURL), "/"))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("SCIM public base URL must be absolute")
	}
	handler := &HTTPHandler{service: service, baseURL: parsed.String(), mux: http.NewServeMux()}
	handler.registerRoutes()
	return handler, nil
}

func (h *HTTPHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	h.mux.ServeHTTP(response, request)
}

func (h *HTTPHandler) registerRoutes() {
	h.mux.HandleFunc("GET /scim/v2/ServiceProviderConfig", h.withAuthorization(domain.SCIMScopeRead, h.serviceProviderConfig))
	h.mux.HandleFunc("GET /scim/v2/ResourceTypes", h.withAuthorization(domain.SCIMScopeRead, h.resourceTypes))
	h.mux.HandleFunc("GET /scim/v2/ResourceTypes/{id}", h.withAuthorization(domain.SCIMScopeRead, h.resourceType))
	h.mux.HandleFunc("GET /scim/v2/Schemas", h.withAuthorization(domain.SCIMScopeRead, h.schemas))
	h.mux.HandleFunc("GET /scim/v2/Schemas/{id}", h.withAuthorization(domain.SCIMScopeRead, h.schema))
	h.mux.HandleFunc("GET /scim/v2/Users", h.withAuthorization(domain.SCIMScopeRead, h.listUsers))
	h.mux.HandleFunc("POST /scim/v2/Users", h.withAuthorization(domain.SCIMScopeWrite, h.createUser))
	h.mux.HandleFunc("GET /scim/v2/Users/{id}", h.withAuthorization(domain.SCIMScopeRead, h.getUser))
	h.mux.HandleFunc("PUT /scim/v2/Users/{id}", h.withAuthorization(domain.SCIMScopeWrite, h.replaceUser))
	h.mux.HandleFunc("PATCH /scim/v2/Users/{id}", h.withAuthorization(domain.SCIMScopeWrite, h.patchUser))
	h.mux.HandleFunc("DELETE /scim/v2/Users/{id}", h.withAuthorization(domain.SCIMScopeWrite, h.deleteUser))
	h.mux.HandleFunc("GET /scim/v2/Groups", h.withAuthorization(domain.SCIMScopeRead, h.listGroups))
	h.mux.HandleFunc("POST /scim/v2/Groups", h.withAuthorization(domain.SCIMScopeWrite, h.createGroup))
	h.mux.HandleFunc("GET /scim/v2/Groups/{id}", h.withAuthorization(domain.SCIMScopeRead, h.getGroup))
	h.mux.HandleFunc("PUT /scim/v2/Groups/{id}", h.withAuthorization(domain.SCIMScopeWrite, h.replaceGroup))
	h.mux.HandleFunc("PATCH /scim/v2/Groups/{id}", h.withAuthorization(domain.SCIMScopeWrite, h.patchGroup))
	h.mux.HandleFunc("DELETE /scim/v2/Groups/{id}", h.withAuthorization(domain.SCIMScopeWrite, h.deleteGroup))
	h.registerMethodFallback("/scim/v2/ServiceProviderConfig", http.MethodGet)
	h.registerMethodFallback("/scim/v2/ResourceTypes", http.MethodGet)
	h.registerMethodFallback("/scim/v2/ResourceTypes/{id}", http.MethodGet)
	h.registerMethodFallback("/scim/v2/Schemas", http.MethodGet)
	h.registerMethodFallback("/scim/v2/Schemas/{id}", http.MethodGet)
	h.registerMethodFallback("/scim/v2/Users", http.MethodGet+", "+http.MethodPost)
	h.registerMethodFallback(
		"/scim/v2/Users/{id}",
		http.MethodGet+", "+http.MethodPut+", "+http.MethodPatch+", "+http.MethodDelete,
	)
	h.registerMethodFallback("/scim/v2/Groups", http.MethodGet+", "+http.MethodPost)
	h.registerMethodFallback(
		"/scim/v2/Groups/{id}",
		http.MethodGet+", "+http.MethodPut+", "+http.MethodPatch+", "+http.MethodDelete,
	)
	h.mux.HandleFunc("/scim/v2/{path...}", func(response http.ResponseWriter, _ *http.Request) {
		writeSCIMError(response, http.StatusNotFound, "", "The SCIM endpoint does not exist")
	})
}

func (h *HTTPHandler) registerMethodFallback(pattern, allowed string) {
	h.mux.HandleFunc(pattern, func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Allow", allowed)
		writeSCIMError(response, http.StatusMethodNotAllowed, "", "The SCIM method is not allowed for this endpoint")
	})
}

type authorizedHandler func(http.ResponseWriter, *http.Request, Authorization)

func (h *HTTPHandler) withAuthorization(scope string, next authorizedHandler) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		raw := strings.TrimSpace(request.Header.Get("Authorization"))
		if !strings.HasPrefix(strings.ToLower(raw), "bearer ") {
			response.Header().Set("WWW-Authenticate", `Bearer realm="antnest-scim"`)
			writeSCIMError(response, http.StatusUnauthorized, "", "A valid SCIM Bearer token is required")
			return
		}
		authorization, err := h.service.Authorize(request.Context(), strings.TrimSpace(raw[len("Bearer "):]), scope)
		if err != nil {
			setBearerChallenge(response, err, scope)
			writeServiceError(response, err)
			return
		}
		next(response, request, authorization)
	}
}

func (h *HTTPHandler) serviceProviderConfig(response http.ResponseWriter, _ *http.Request, _ Authorization) {
	writeSCIM(response, http.StatusOK, map[string]any{
		"schemas":        []string{"urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"},
		"patch":          map[string]bool{"supported": true},
		"bulk":           map[string]any{"supported": false, "maxOperations": 0, "maxPayloadSize": 0},
		"filter":         map[string]any{"supported": true, "maxResults": 200},
		"changePassword": map[string]bool{"supported": false},
		"sort":           map[string]bool{"supported": false},
		"etag":           map[string]bool{"supported": false},
		"authenticationSchemes": []map[string]any{{
			"type": "oauthbearertoken", "name": "OAuth Bearer Token",
			"description": "Organization-scoped Antnest SCIM Bearer token",
			"specUri":     "https://www.rfc-editor.org/rfc/rfc6750",
			"primary":     true,
		}},
		"meta": map[string]any{"resourceType": "ServiceProviderConfig", "location": h.location("ServiceProviderConfig")},
	})
}

func (h *HTTPHandler) resourceTypes(response http.ResponseWriter, _ *http.Request, _ Authorization) {
	resources := h.resourceTypeDefinitions()
	writeSCIM(response, http.StatusOK, listResponse(resources, len(resources), 1))
}

func (h *HTTPHandler) resourceType(response http.ResponseWriter, request *http.Request, _ Authorization) {
	for _, resource := range h.resourceTypeDefinitions() {
		if resource["id"] == request.PathValue("id") {
			writeSCIM(response, http.StatusOK, resource)
			return
		}
	}
	writeSCIMError(response, http.StatusNotFound, "", "The SCIM ResourceType does not exist")
}

func (h *HTTPHandler) resourceTypeDefinitions() []map[string]any {
	return []map[string]any{
		{"schemas": []string{"urn:ietf:params:scim:schemas:core:2.0:ResourceType"}, "id": "User", "name": "User", "endpoint": "/Users", "schema": userSchema,
			"meta": map[string]any{"resourceType": "ResourceType", "location": h.location("ResourceTypes", "User")}},
		{"schemas": []string{"urn:ietf:params:scim:schemas:core:2.0:ResourceType"}, "id": "Group", "name": "Group", "endpoint": "/Groups", "schema": groupSchema,
			"meta": map[string]any{"resourceType": "ResourceType", "location": h.location("ResourceTypes", "Group")}},
	}
}

func (h *HTTPHandler) schemas(response http.ResponseWriter, _ *http.Request, _ Authorization) {
	resources := h.schemaDefinitions()
	writeSCIM(response, http.StatusOK, listResponse(resources, len(resources), 1))
}

func (h *HTTPHandler) schema(response http.ResponseWriter, request *http.Request, _ Authorization) {
	for _, schema := range h.schemaDefinitions() {
		if schema["id"] == request.PathValue("id") {
			writeSCIM(response, http.StatusOK, schema)
			return
		}
	}
	writeSCIMError(response, http.StatusNotFound, "", "The SCIM Schema does not exist")
}

func (h *HTTPHandler) schemaDefinitions() []map[string]any {
	return []map[string]any{
		{
			"schemas": []string{"urn:ietf:params:scim:schemas:core:2.0:Schema"},
			"id":      userSchema,
			"name":    "User",
			"meta":    map[string]any{"resourceType": "Schema", "location": h.location("Schemas", userSchema)},
			"attributes": []map[string]any{
				scimAttribute("userName", "string", false, true, "readWrite", "server"),
				scimAttribute("displayName", "string", false, false, "readWrite", "none"),
				{
					"name": "name", "type": "complex", "multiValued": false,
					"required": false, "mutability": "readWrite", "returned": "default",
					"uniqueness": "none",
					"subAttributes": []map[string]any{
						scimAttribute("formatted", "string", false, false, "readWrite", "none"),
					},
				},
				scimAttribute("active", "boolean", false, false, "readWrite", "none"),
				{
					"name": "emails", "type": "complex", "multiValued": true,
					"required": false, "mutability": "readWrite", "returned": "default",
					"uniqueness": "none",
					"subAttributes": []map[string]any{
						scimAttribute("value", "string", false, true, "readWrite", "none"),
						scimAttribute("primary", "boolean", false, false, "readWrite", "none"),
					},
				},
			},
		},
		{
			"schemas": []string{"urn:ietf:params:scim:schemas:core:2.0:Schema"},
			"id":      groupSchema,
			"name":    "Group",
			"meta":    map[string]any{"resourceType": "Schema", "location": h.location("Schemas", groupSchema)},
			"attributes": []map[string]any{
				scimAttribute("displayName", "string", false, true, "readWrite", "none"),
				{
					"name": "members", "type": "complex", "multiValued": true,
					"required": false, "mutability": "readWrite", "returned": "default",
					"uniqueness": "none",
					"subAttributes": []map[string]any{
						scimAttribute("value", "string", false, true, "readWrite", "none"),
						scimAttribute("$ref", "reference", false, false, "readOnly", "none"),
					},
				},
			},
		},
	}
}

func scimAttribute(name, attributeType string, multiValued, required bool, mutability, uniqueness string) map[string]any {
	return map[string]any{
		"name": name, "type": attributeType, "multiValued": multiValued,
		"required": required, "mutability": mutability, "returned": "default", "uniqueness": uniqueness,
	}
}

func decodeSCIMBody(response http.ResponseWriter, request *http.Request, target any) bool {
	request.Body = http.MaxBytesReader(response, request.Body, maxSCIMBody)
	decoder := json.NewDecoder(request.Body)
	if err := decoder.Decode(target); err != nil {
		writeSCIMError(response, http.StatusBadRequest, "invalidValue", "The SCIM request body is invalid")
		return false
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); err != io.EOF {
		writeSCIMError(response, http.StatusBadRequest, "invalidValue", "The SCIM request body must contain one JSON object")
		return false
	}
	return true
}

func listQueryFromRequest(request *http.Request) (ListQuery, error) {
	query := ListQuery{StartIndex: 1, Count: 100}
	if raw := request.URL.Query().Get("startIndex"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 {
			return ListQuery{}, &queryValidationError{
				scimType: "invalidValue", message: "startIndex must be a positive integer",
			}
		}
		query.StartIndex = value
	}
	if raw := request.URL.Query().Get("count"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 0 {
			return ListQuery{}, &queryValidationError{
				scimType: "invalidValue", message: "count must be a non-negative integer",
			}
		}
		query.Count = value
	}
	if raw := request.URL.Query().Get("filter"); raw != "" {
		matches := eqFilterPattern.FindStringSubmatch(raw)
		if len(matches) != 3 {
			return ListQuery{}, &queryValidationError{
				scimType: "invalidFilter", message: "only exact eq filters are supported",
			}
		}
		query.FilterAttribute, query.FilterValue = matches[1], matches[2]
	}
	return query, nil
}

type queryValidationError struct {
	scimType string
	message  string
}

func (e *queryValidationError) Error() string { return e.message }

func writeListQueryError(response http.ResponseWriter, err error) {
	var validationError *queryValidationError
	if errors.As(err, &validationError) {
		writeSCIMError(response, http.StatusBadRequest, validationError.scimType, validationError.message)
		return
	}
	writeSCIMError(response, http.StatusBadRequest, "invalidFilter", err.Error())
}

func (h *HTTPHandler) location(parts ...string) string {
	return h.baseURL + "/scim/v2/" + strings.Join(parts, "/")
}

func listResponse(resources any, totalResults, startIndex int) map[string]any {
	return map[string]any{
		"schemas": []string{listResponseSchema}, "totalResults": totalResults,
		"startIndex": startIndex, "itemsPerPage": sliceLength(resources), "Resources": resources,
	}
}

func sliceLength(value any) int {
	encoded, _ := json.Marshal(value)
	var items []json.RawMessage
	_ = json.Unmarshal(encoded, &items)
	return len(items)
}

func equalFoldAny(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if strings.EqualFold(value, candidate) {
			return true
		}
	}
	return false
}

func validateSchemas(schemas []string, required string) error {
	for _, schema := range schemas {
		if schema == required {
			return nil
		}
	}
	return fmt.Errorf("SCIM schemas must include %q", required)
}

func writeSCIM(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/scim+json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}

func writeServiceError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, domain.ErrInvalidArgument):
		writeSCIMError(response, http.StatusBadRequest, "invalidValue", err.Error())
	case errors.Is(err, domain.ErrUnauthenticated):
		writeSCIMError(response, http.StatusUnauthorized, "", "The SCIM Bearer token is invalid")
	case errors.Is(err, domain.ErrForbidden):
		writeSCIMError(response, http.StatusForbidden, "", "The SCIM Bearer token lacks the required scope")
	case errors.Is(err, domain.ErrNotFound):
		writeSCIMError(response, http.StatusNotFound, "", "The SCIM resource does not exist")
	case errors.Is(err, domain.ErrConflict):
		writeSCIMError(response, http.StatusConflict, "uniqueness", "The SCIM resource conflicts with an existing resource")
	case errors.Is(err, domain.ErrVersionConflict):
		writeSCIMError(response, http.StatusConflict, "", "The SCIM resource changed concurrently")
	case errors.Is(err, domain.ErrInvalidReference):
		writeSCIMError(response, http.StatusBadRequest, "invalidValue", "A SCIM member reference is invalid")
	default:
		code, message, _ := domain.ErrorDetails(err)
		if code == "invalid_filter" {
			writeSCIMError(response, http.StatusBadRequest, "invalidFilter", message)
			return
		}
		writeSCIMError(response, http.StatusInternalServerError, "", "Identity Service could not complete the SCIM request")
	}
}

func setBearerChallenge(response http.ResponseWriter, err error, requiredScope string) {
	switch {
	case errors.Is(err, domain.ErrUnauthenticated):
		response.Header().Set(
			"WWW-Authenticate",
			`Bearer realm="antnest-scim", error="invalid_token"`,
		)
	case errors.Is(err, domain.ErrForbidden):
		response.Header().Set(
			"WWW-Authenticate",
			fmt.Sprintf(
				`Bearer realm="antnest-scim", error="insufficient_scope", scope=%q`,
				requiredScope,
			),
		)
	}
}

func writeSCIMError(response http.ResponseWriter, status int, scimType, detail string) {
	value := map[string]any{
		"schemas": []string{errorSchema}, "status": strconv.Itoa(status), "detail": detail,
	}
	if scimType != "" {
		value["scimType"] = scimType
	}
	writeSCIM(response, status, value)
}
