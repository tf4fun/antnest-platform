package postgres

import (
	"reflect"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestControllerRepositoryHasNoExecutionCommands(t *testing.T) {
	t.Parallel()
	store := reflect.TypeFor[*Repository]()
	for _, method := range []string{"AcquireRun", "ReplayRunAdmission", "ResolveRunAuthorization", "FinishRun", "GetAdmissionCredential", "GetSessionConfiguration", "ResolveAgentAccess"} {
		t.Run(method, func(t *testing.T) {
			_, found := store.MethodByName(method)
			require.False(t, found, "execution belongs to ACP, not the management repository")
		})
	}
}
