package postgres

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/instanceauth"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/repository"
)

func TestInstanceAuthorityUsesAcceptedOperationTransaction(t *testing.T) {
	issuer, _ := instanceauth.New(bytes.Repeat([]byte{42}, 32))
	id := instanceauth.Identity{Scope: "scope-a", AgentID: "agent-1", Generation: 1}
	record, _ := issuer.Issue(id)
	operation := deployment.Operation{Kind: deployment.OperationInitializeRuntime, MaintenanceVerifiers: &deployment.MaintenanceVerifiers{Keys: []deployment.MaintenanceVerifierKey{}}, InstanceAuthentication: record}
	arguments, err := operationArguments(operation)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(record)
	if !reflect.DeepEqual(arguments[len(arguments)-1], encoded) || !strings.Contains(insertOperationSQL, "instance_authentication") || !strings.Contains(operationColumns, "instance_authentication") {
		t.Fatal("instance authority is outside operation admission transaction")
	}
	for _, caller := range []string{"runtime-controller", "agent-acp-service"} {
		token, _ := issuer.Open(id, record, caller)
		if bytes.Contains(encoded, []byte(token)) {
			t.Fatal("accepted journal has a raw bearer")
		}
	}
	var _ repository.InstanceCredentialStore = (*Repository)(nil)
	var _ = (*Repository).GenerationOperation
}
