package postgres

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestControllerSchemaOwnsOnlyManagementFacts(t *testing.T) {
	repository := providerTestRepository(t)
	assertManagementOnlySchema(t, repository)
	require.NoError(t, repository.Migrate(t.Context()), "fresh migrations must replay without mutation")
	assertManagementOnlySchema(t, repository)
}

func assertManagementOnlySchema(t *testing.T, repository *Repository) {
	t.Helper()
	var count int
	err := repository.pool.QueryRow(t.Context(), `SELECT count(*) FROM information_schema.tables
 WHERE table_schema='agent_controller' AND table_name='run_admissions'`).Scan(&count)
	require.NoError(t, err)
	require.Zero(t, count, "Controller cannot retain a second execution authority")
	err = repository.pool.QueryRow(t.Context(), `SELECT count(*) FROM information_schema.columns
 WHERE table_schema='agent_controller' AND
 ((table_name='agent_events' AND column_name='admission_id') OR
  (table_name='agent_access_bindings' AND column_name IN ('access_subject','prompt_image','prompt_audio','prompt_embedded_context')))`).Scan(&count)
	require.NoError(t, err)
	require.Zero(t, count, "routing secrets and execution-only fields must not survive as unused columns")
}
