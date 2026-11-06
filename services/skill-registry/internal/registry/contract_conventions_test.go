package registry

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func conventionsFixture(t *testing.T) (*handlerFixture, *memoryStore) {
	t.Helper()
	store := &memoryStore{}
	return newTestHandler(t, NewService(store)), store
}

func conventionsPublish(t *testing.T, handler *handlerFixture, metadata map[string]any, manifest string) Version {
	t.Helper()
	request := publishRequest(t, metadata, skillZIP(t, manifest))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, handler.Authenticate(request))
	if response.Code != http.StatusCreated {
		t.Fatalf("publish status=%d body=%s", response.Code, response.Body.String())
	}
	var published Version
	if err := json.Unmarshal(response.Body.Bytes(), &published); err != nil {
		t.Fatal(err)
	}
	return published
}

func conventionsRawMultipart(t *testing.T, url, metadataJSON string, archive []byte) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormField("metadata")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte(metadataJSON)); err != nil {
		t.Fatal(err)
	}
	part, err = writer.CreateFormFile("artifact", "skill.zip")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(archive); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, url, &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("Authorization", "Bearer "+testToken)
	return request
}

func conventionsGet(t *testing.T, handler *handlerFixture, url string) (int, []byte) {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, url, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, handler.Authenticate(request))
	return response.Code, response.Body.Bytes()
}

func conventionsVersionList(t *testing.T, handler *handlerFixture, skillID string) int {
	t.Helper()
	code, body := conventionsGet(t, handler, "/internal/skills/"+skillID+"/versions?organization_id="+testOrg)
	if code != http.StatusOK {
		t.Fatalf("versions status=%d body=%s", code, body)
	}
	var page struct {
		Items []Version `json:"items"`
	}
	if err := json.Unmarshal(body, &page); err != nil {
		t.Fatal(err)
	}
	return len(page.Items)
}

func TestContractConventionsListPaginationForms(t *testing.T) {
	handler, _ := conventionsFixture(t)
	first := conventionsPublish(t, handler, map[string]any{
		"request_id": "r1", "organization_id": testOrg, "actor_id": testActor},
		"---\nname: alpha\ndescription: Alpha\n---\n")
	conventionsPublish(t, handler, map[string]any{
		"request_id": "r2", "organization_id": testOrg, "actor_id": testActor},
		"---\nname: beta\ndescription: Beta\n---\n")
	archive := skillZIP(t, "---\nname: alpha\ndescription: Alpha v2\n---\n")
	for _, metadata := range []map[string]any{
		{"request_id": "r3", "organization_id": testOrg, "actor_id": testActor, "expected_version": 1},
	} {
		request := publishRequest(t, metadata, archive)
		request.URL.Path = "/internal/skills/" + first.SkillID + "/versions"
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, handler.Authenticate(request))
		if response.Code != http.StatusCreated {
			t.Fatalf("append status=%d body=%s", response.Code, response.Body.String())
		}
	}
	_ = first

	for _, route := range []struct {
		name, base, alias string
	}{
		{name: "skills", base: "/internal/skills?organization_id=" + testOrg + "&limit=1", alias: "after_id"},
		{name: "versions", base: "/internal/skills/" + first.SkillID + "/versions?organization_id=" + testOrg + "&limit=1", alias: "after_version"},
	} {
		code, body := conventionsGet(t, handler, route.base)
		if code != http.StatusOK {
			t.Fatalf("%s first page status=%d body=%s", route.name, code, body)
		}
		var page struct {
			Items      []json.RawMessage `json:"items"`
			NextCursor *string           `json:"next_cursor"`
		}
		if err := json.Unmarshal(body, &page); err != nil {
			t.Fatalf("%s decode: %v", route.name, err)
		}
		if len(page.Items) != 1 || page.NextCursor == nil {
			t.Fatalf("%s first page=%s", route.name, body)
		}
		if bytes.Contains(body, []byte("next_after_id")) || bytes.Contains(body, []byte("next_after_version")) {
			t.Fatalf("%s legacy cursor field emitted: %s", route.name, body)
		}
		cursor := *page.NextCursor
		for _, query := range []string{"cursor=" + cursor, route.alias + "=" + cursor} {
			code, body = conventionsGet(t, handler, route.base+"&"+query)
			if code != http.StatusOK {
				t.Fatalf("%s continuation %s status=%d body=%s", route.name, query, code, body)
			}
			page.NextCursor = nil
			if err := json.Unmarshal(body, &page); err != nil {
				t.Fatal(err)
			}
			if len(page.Items) != 1 || page.NextCursor != nil {
				t.Fatalf("%s continuation %s page=%s", route.name, query, body)
			}
		}
	}
	code, body := conventionsGet(t, handler, "/internal/skills/"+first.SkillID+"/versions?organization_id="+testOrg+"&limit=1")
	if code != http.StatusOK || !strings.Contains(string(body), `"next_cursor":"`) || strings.Contains(string(body), `"next_cursor":1`) || strings.Contains(string(body), `"next_cursor":2`) {
		t.Fatalf("version cursor must be an opaque string: %d %s", code, body)
	}
}

func TestContractConventionsListRejectsBadQuery(t *testing.T) {
	handler, _ := conventionsFixture(t)
	published := conventionsPublish(t, handler, map[string]any{
		"request_id": "r1", "organization_id": testOrg, "actor_id": testActor},
		"---\nname: alpha\ndescription: Alpha\n---\n")
	for _, route := range []struct {
		name, base, alias string
	}{
		{name: "skills", base: "/internal/skills?organization_id=" + testOrg, alias: "after_id"},
		{name: "versions", base: "/internal/skills/" + published.SkillID + "/versions?organization_id=" + testOrg, alias: "after_version"},
	} {
		for _, query := range []string{
			"cursor=x&" + route.alias + "=x",
			"cursor=x&" + route.alias + "=y",
			"cursor=x&cursor=y",
			"unknown=1",
			"cursor=",
			"cursor=" + strings.Repeat("a", 4097),
			"limit=0",
			"limit=101",
			"limit=-1",
			"limit=abc",
		} {
			code, body := conventionsGet(t, handler, route.base+"&"+query)
			if code != http.StatusBadRequest {
				t.Fatalf("%s ?%s status=%d body=%s", route.name, query, code, body)
			}
		}
	}
}

func TestContractConventionsAppendPreconditionForms(t *testing.T) {
	for _, form := range []struct {
		name    string
		version any
		ifMatch string
	}{
		{name: "canonical", version: "1"},
		{name: "legacy", version: int64(1)},
		{name: "if_match", ifMatch: `"1"`},
	} {
		t.Run(form.name, func(t *testing.T) {
			handler, _ := conventionsFixture(t)
			published := conventionsPublish(t, handler, map[string]any{
				"request_id": "r1", "organization_id": testOrg, "actor_id": testActor},
				"---\nname: alpha\ndescription: Alpha\n---\n")
			metadata := map[string]any{
				"request_id": "r-append-" + form.name, "organization_id": testOrg, "actor_id": testActor}
			if form.version != nil {
				metadata["expected_version"] = form.version
			}
			request := publishRequest(t, metadata, skillZIP(t, "---\nname: alpha\ndescription: Alpha v2\n---\n"))
			request.URL.Path = "/internal/skills/" + published.SkillID + "/versions"
			if form.ifMatch != "" {
				request.Header.Set("If-Match", form.ifMatch)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, handler.Authenticate(request))
			if response.Code != http.StatusCreated {
				t.Fatalf("append status=%d body=%s", response.Code, response.Body.String())
			}
			var appended Version
			if err := json.Unmarshal(response.Body.Bytes(), &appended); err != nil {
				t.Fatal(err)
			}
			if appended.Version != 2 {
				t.Fatalf("appended version=%d", appended.Version)
			}
		})
	}
}

func TestContractConventionsCreateRejectsPreconditionForms(t *testing.T) {
	handler, _ := conventionsFixture(t)
	for _, metadata := range []map[string]any{
		{"request_id": "r1", "organization_id": testOrg, "actor_id": testActor, "expected_version": "0"},
		{"request_id": "r2", "organization_id": testOrg, "actor_id": testActor, "expected_version": 0},
	} {
		request := publishRequest(t, metadata, skillZIP(t, "---\nname: alpha\ndescription: A\n---\n"))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, handler.Authenticate(request))
		if response.Code != http.StatusBadRequest {
			t.Fatalf("create with expected_version status=%d body=%s", response.Code, response.Body.String())
		}
	}
	request := publishRequest(t, map[string]any{
		"request_id": "r3", "organization_id": testOrg, "actor_id": testActor},
		skillZIP(t, "---\nname: alpha\ndescription: A\n---\n"))
	request.Header.Set("If-Match", `"0"`)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, handler.Authenticate(request))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("create with If-Match status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestContractConventionsAppendRejections(t *testing.T) {
	for _, test := range []struct {
		name     string
		metadata map[string]any
		rawMeta  string
		ifMatch  []string
	}{
		{name: "missing"},
		{name: "null", metadata: map[string]any{"expected_version": nil}},
		{name: "empty", metadata: map[string]any{"expected_version": ""}},
		{name: "bool", metadata: map[string]any{"expected_version": true}},
		{name: "fraction", metadata: map[string]any{"expected_version": 1.5}},
		{name: "exponent", metadata: map[string]any{"expected_version": "1e2"}},
		{name: "negative", metadata: map[string]any{"expected_version": "-1"}},
		{name: "leading_zero", metadata: map[string]any{"expected_version": "01"}},
		{name: "overflow", metadata: map[string]any{"expected_version": "18446744073709551616"}},
		{name: "text", metadata: map[string]any{"expected_version": "abc"}},
		{name: "unknown_field", metadata: map[string]any{"expected_version": "1", "admin": true}},
		{name: "duplicate_field", rawMeta: `{"request_id":"rx","organization_id":"` + testOrg + `","actor_id":"` + testActor + `","expected_version":"1","expected_version":"1"}`},
		{name: "body_and_header", metadata: map[string]any{"expected_version": "1"}, ifMatch: []string{`"1"`}},
		{name: "weak_tag", ifMatch: []string{`W/"1"`}},
		{name: "wildcard", ifMatch: []string{`*`}},
		{name: "tag_list", ifMatch: []string{`"1", "1"`}},
		{name: "repeated_header", ifMatch: []string{`"1"`, `"1"`}},
		{name: "control_header", ifMatch: []string{"\"1\t\""}},
	} {
		t.Run(test.name, func(t *testing.T) {
			handler, _ := conventionsFixture(t)
			published := conventionsPublish(t, handler, map[string]any{
				"request_id": "r1", "organization_id": testOrg, "actor_id": testActor},
				"---\nname: alpha\ndescription: Alpha\n---\n")
			archive := skillZIP(t, "---\nname: alpha\ndescription: Alpha v2\n---\n")
			var request *http.Request
			if test.rawMeta != "" {
				request = conventionsRawMultipart(t, "/internal/skills/"+published.SkillID+"/versions", test.rawMeta, archive)
			} else {
				metadata := map[string]any{
					"request_id": "rx", "organization_id": testOrg, "actor_id": testActor}
				for key, value := range test.metadata {
					metadata[key] = value
				}
				request = publishRequest(t, metadata, archive)
				request.URL.Path = "/internal/skills/" + published.SkillID + "/versions"
			}
			for _, tag := range test.ifMatch {
				request.Header.Add("If-Match", tag)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, handler.Authenticate(request))
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if got := conventionsVersionList(t, handler, published.SkillID); got != 1 {
				t.Fatalf("versions stored=%d", got)
			}
		})
	}
}

func TestContractConventionsReplayUsesRequestKey(t *testing.T) {
	handler, _ := conventionsFixture(t)
	published := conventionsPublish(t, handler, map[string]any{
		"request_id": "r1", "organization_id": testOrg, "actor_id": testActor},
		"---\nname: alpha\ndescription: Alpha\n---\n")
	metadata := map[string]any{
		"request_id": "r-append", "organization_id": testOrg, "actor_id": testActor,
		"expected_version": "1"}
	request := publishRequest(t, metadata, skillZIP(t, "---\nname: alpha\ndescription: Alpha v2\n---\n"))
	request.URL.Path = "/internal/skills/" + published.SkillID + "/versions"
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, handler.Authenticate(request))
	if response.Code != http.StatusCreated {
		t.Fatalf("append status=%d body=%s", response.Code, response.Body.String())
	}
	first := append([]byte(nil), response.Body.Bytes()...)
	replay := publishRequest(t, metadata, skillZIP(t, "---\nname: alpha\ndescription: Alpha v2\n---\n"))
	replay.URL.Path = "/internal/skills/" + published.SkillID + "/versions"
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, handler.Authenticate(replay))
	if response.Code != http.StatusCreated && response.Code != http.StatusOK {
		t.Fatalf("replay status=%d body=%s", response.Code, response.Body.String())
	}
	if !bytes.Equal(first, response.Body.Bytes()) {
		t.Fatalf("replay differs: %s vs %s", first, response.Body.Bytes())
	}
	conflict := publishRequest(t, map[string]any{
		"request_id": "r-append", "organization_id": testOrg, "actor_id": testActor,
		"expected_version": "2"}, skillZIP(t, "---\nname: alpha\ndescription: Alpha v2\n---\n"))
	conflict.URL.Path = "/internal/skills/" + published.SkillID + "/versions"
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, handler.Authenticate(conflict))
	if response.Code != http.StatusConflict {
		t.Fatalf("conflict status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestContractConventionsPromotionPreconditionForms(t *testing.T) {
	for _, form := range []struct {
		name    string
		version any
		ifMatch string
		valid   bool
	}{
		{name: "canonical", version: "1", valid: true},
		{name: "legacy", version: int64(1), valid: true},
		{name: "if_match", ifMatch: `"1"`, valid: true},
		{name: "aliases_equal", version: int64(1), ifMatch: `"1"`},
		{name: "weak_tag", ifMatch: `W/"1"`},
		{name: "wildcard", ifMatch: `*`},
		{name: "numeric_bad", version: "abc"},
		{name: "null", version: nil},
	} {
		t.Run(form.name, func(t *testing.T) {
			discovery, store, _, _, load := discoveryFixture(t)
			handler := newTestHandler(t, NewService(store), discovery)
			metadata := map[string]any{
				"request_id": "rp", "organization_id": testOrg, "actor_id": testActor,
				"skill_ref":       load.SkillRef,
				"expected_digest": load.ExpectedDigest,
				"skill_id":        "skill_0123456789abcdef0123456789abcdef"}
			if form.version != nil || form.name == "null" {
				metadata["expected_version"] = form.version
			}
			encoded, err := json.Marshal(metadata)
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodPost, "/internal/skill-projections/promote",
				bytes.NewReader(encoded))
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Authorization", "Bearer "+testToken)
			if form.ifMatch != "" {
				request.Header.Set("If-Match", form.ifMatch)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, handler.Authenticate(request))
			isPreconditionRejection := response.Code == http.StatusBadRequest &&
				bytes.Contains(response.Body.Bytes(), []byte("invalid_request"))
			if form.valid && isPreconditionRejection {
				t.Fatalf("valid form rejected: %d %s", response.Code, response.Body.String())
			}
			if !form.valid && response.Code != http.StatusBadRequest {
				t.Fatalf("invalid form accepted: %d %s", response.Code, response.Body.String())
			}
		})
	}
}
