package postgres

import "testing"

func TestRepositoryObservationConcurrentWritesWithoutPruning(t *testing.T) {
	// Match the pruning isolation workload while omitting every pruning resource.
	// The 5,000 expired facts remain, and all 100 writes are single attempts.
	testObservationWriteConcurrency(t, observationWriteConcurrency{
		appendWriters: 99, completionWriters: 1,
	})
}
