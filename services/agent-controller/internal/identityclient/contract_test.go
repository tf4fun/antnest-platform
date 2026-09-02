package identityclient

import (
	"encoding/json"
	"net/http"
	"os"
	"slices"
	"testing"
)

func TestIdentityContractMatchesResolvePrincipalConsumer(t *testing.T) {
	t.Parallel()

	encoded, err := os.ReadFile("../../../../contracts/identity/identity-contract.json")
	if err != nil {
		t.Fatalf("read Identity contract: %v", err)
	}
	var contract struct {
		Revision    int    `json:"revision"`
		BasePath    string `json:"base_path"`
		Definitions struct {
			OrganizationPrincipalBinding struct {
				Required []string `json:"required"`
			} `json:"organization_principal_binding"`
		} `json:"definitions"`
		Error struct {
			HTTPStatusByCode map[string]int `json:"http_status_by_code"`
		} `json:"error"`
		Methods map[string]struct {
			Method   string `json:"method"`
			Path     string `json:"path"`
			Response struct {
				Properties struct {
					Principal struct {
						Reference string `json:"$ref"`
					} `json:"principal"`
				} `json:"properties"`
			} `json:"response"`
		} `json:"methods"`
	}
	if err := json.Unmarshal(encoded, &contract); err != nil {
		t.Fatalf("decode Identity contract: %v", err)
	}
	route, ok := contract.Methods["resolve_principal"]
	if contract.Revision != 7 || contract.BasePath != "/rpc/identity" || !ok ||
		route.Method != http.MethodPost || route.Path != "/resolve-principal" ||
		route.Response.Properties.Principal.Reference !=
			"#/definitions/organization_principal_binding" {
		t.Fatalf("Identity resolve-principal contract drifted: revision=%d base=%q route=%+v",
			contract.Revision, contract.BasePath, route)
	}
	required := slices.Clone(contract.Definitions.OrganizationPrincipalBinding.Required)
	slices.Sort(required)
	wantRequired := []string{"active", "membership_id", "organization_id", "user_id"}
	if !slices.Equal(required, wantRequired) {
		t.Fatalf("Identity binding fields=%v want=%v", required, wantRequired)
	}
	for code, expected := range resolvePrincipalFailures {
		if contract.Error.HTTPStatusByCode[code] != expected.status {
			t.Fatalf("Identity error %q status=%d want=%d",
				code, contract.Error.HTTPStatusByCode[code], expected.status)
		}
	}
}
