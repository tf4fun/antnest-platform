package rpc

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"soft/antnest-platform/services/identity-service/internal/directory"
	"soft/antnest-platform/services/identity-service/internal/domain"
)

func TestPrincipalRevocationsRPCRequiresExplicitCursorAndLimit(t *testing.T) {
	for _, body := range []string{`{}`, `{"after_sequence":0}`, `{"limit":1}`, `{"after_sequence":null,"limit":1}`, `{"after_sequence":0,"limit":1,"token":"secret"}`} {
		t.Run(body, func(t *testing.T) {
			handler := newRPCHandler(t, &rpcServicesStub{})
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost,
				"/rpc/identity/list-principal-revocations", strings.NewReader(body)))
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestPrincipalRevocationsRPCEmptyPageRetainsCursor(t *testing.T) {
	handler := newRPCHandler(t, &rpcServicesStub{})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost,
		"/rpc/identity/list-principal-revocations", strings.NewReader(`{"after_sequence":9,"limit":500}`)))
	var page domain.PrincipalRevocationPage
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusOK || page.NextSequence != 9 || page.Events == nil || len(page.Events) != 0 {
		t.Fatalf("status=%d page=%#v", response.Code, page)
	}
}

func (*rpcServicesStub) ListPrincipalRevocations(_ context.Context, query directory.RevocationQuery) (domain.PrincipalRevocationPage, error) {
	return domain.PrincipalRevocationPage{Events: []domain.PrincipalRevocation{}, NextSequence: query.AfterSequence}, nil
}
