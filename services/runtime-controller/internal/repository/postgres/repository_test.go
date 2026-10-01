package postgres

import (
	"database/sql"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/deployment"
	"soft/antnest-platform/services/runtime-controller/internal/repository"
)

const testRevision = deployment.RuntimeRevision("rtv_0123456789abcdef0123456789abcdef")

func TestPrivateSchemaContainsOnlyControllerRecoveryState(t *testing.T) {
	schemaSQL := bootstrapSQL + initialSchemaSQL
	for _, table := range []string{
		"runtime_controller.schema_migrations",
		"runtime_controller.operations",
		"runtime_controller.runtime_environments",
		"runtime_controller.generation_claims",
		"runtime_controller.observations",
	} {
		if !strings.Contains(schemaSQL, table) {
			t.Fatalf("private schema is missing %s", table)
		}
	}
	for _, forbidden := range []string{"agent_specs", "runs", "tools", "egress", "provider", "channel"} {
		if strings.Contains(strings.ToLower(schemaSQL), forbidden) {
			t.Fatalf("private schema absorbed foreign concept %q", forbidden)
		}
	}
}

func TestSchemaMigrationsAreOrderedAndImmutable(t *testing.T) {
	if err := validateMigrationPlan(); err != nil {
		t.Fatal(err)
	}
}

func TestScanOperationRestoresLogicalAndPrivateIdentity(t *testing.T) {
	now := time.Date(2026, 8, 30, 1, 2, 3, 0, time.UTC)
	environment := deployment.Environment{
		AgentID: "agent-1", RuntimeRevision: testRevision,
		LifecycleState: deployment.LifecycleProvisioned, Health: deployment.HealthHealthy,
		RuntimeExecutionID: "execution-1", Generation: 7,
		SpecDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		ObservedAt: now,
	}
	encoded, _ := json.Marshal(environmentSnapshotFromDomain(environment))
	row := valueScanner{values: []any{
		"request-1", "sha256:request", string(deployment.OperationUpdateRuntime), "agent-1",
		string(testRevision), "rtv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		string(deployment.LifecycleProvisioned), "rtv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", uint64(6),
		"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		uint64(7), "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		uint64(3), string(deployment.OperationCompleted), string(deployment.EffectCompleted),
		encoded, "", "", now, now,
		"antnest/runtime:latest", integrationSpecDigest,
		sql.NullInt64{}, "", int64(0), "", "",
		[]byte(`{"keys":[{"kid":"current","algorithm":"Ed25519","public_key_base64url":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}]}`),
	}}

	operation, err := scanOperation(row)
	if err != nil {
		t.Fatal(err)
	}
	if operation.RuntimeKey() != (deployment.Key{AgentID: "agent-1", Generation: 7}) ||
		operation.RuntimeRevision != testRevision || operation.Attempt != 3 ||
		operation.Inspection == nil || operation.Inspection.RuntimeExecutionID != "execution-1" ||
		operation.ImageReference != "antnest/runtime:latest" || operation.ImageID != integrationSpecDigest ||
		operation.MaintenanceVerifiers == nil || operation.MaintenanceVerifiers.Keys[0].KID != "current" {
		t.Fatalf("operation identity was not restored: %+v", operation)
	}
}

func TestScanOperationMapsMissingRecord(t *testing.T) {
	_, err := scanOperation(errorScanner{err: sql.ErrNoRows})
	if !errors.Is(err, repository.ErrNotFound) {
		t.Fatalf("missing operation error = %v", err)
	}
}

func TestScanEnvironmentRestoresLogicalStateAndPrivateKey(t *testing.T) {
	now := time.Date(2026, 8, 30, 1, 2, 3, 0, time.UTC)
	row := valueScanner{values: []any{
		"agent-1", string(testRevision), string(deployment.LifecycleDisabled), uint64(7),
		"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		sql.NullString{}, now,
	}}
	environment, err := scanEnvironment(row)
	if err != nil {
		t.Fatal(err)
	}
	if environment.RuntimeRevision != testRevision || environment.Health != deployment.HealthAbsent ||
		environment.Generation != 7 || environment.OperationID != "" {
		t.Fatalf("environment was not restored: %+v", environment)
	}
}

func TestScanObservationRestoresRevisionAndPrivateKey(t *testing.T) {
	now := time.Date(2026, 8, 30, 1, 2, 3, 0, time.UTC)
	row := valueScanner{values: []any{
		uint64(9), "agent-1", string(testRevision), uint64(7),
		"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"container-1", "execution-1", string(deployment.ObservationHealthy),
		"runtime_status", "", now,
	}}
	observation, err := scanObservation(row)
	if err != nil {
		t.Fatal(err)
	}
	key, ok := observation.RuntimeKey()
	if observation.Sequence != 9 || observation.RuntimeRevision != testRevision || !ok ||
		key != (deployment.Key{AgentID: "agent-1", Generation: 7}) {
		t.Fatalf("observation identity was not restored: %+v", observation)
	}
}

func TestOperationSourceMustMatchEnvironmentHead(t *testing.T) {
	operation := deployment.Operation{
		AgentID: "agent-1", SourceState: deployment.LifecycleProvisioned,
		SourceRevision: testRevision, SourceGeneration: 7,
		SourceSpecDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	}
	environment := deployment.Environment{
		AgentID: "agent-1", LifecycleState: operation.SourceState,
		RuntimeRevision: operation.SourceRevision, Generation: operation.SourceGeneration,
		SpecDigest: operation.SourceSpecDigest,
	}
	if err := matchOperationSource(operation, environment); err != nil {
		t.Fatalf("matching source was rejected: %v", err)
	}
	environment.RuntimeRevision = "rtv_ffffffffffffffffffffffffffffffff"
	if err := matchOperationSource(operation, environment); !errors.Is(err, repository.ErrRevisionConflict) {
		t.Fatalf("stale revision error = %v", err)
	}
}

func TestNewRejectsInvalidRetention(t *testing.T) {
	if _, err := New(&sql.DB{}, &sql.DB{}, 0); err == nil {
		t.Fatal("zero retention was accepted")
	}
	if _, err := New(&sql.DB{}, nil, time.Hour); err == nil {
		t.Fatal("missing dedicated Agent lock database was accepted")
	}
}

type valueScanner struct {
	values []any
}

func (s valueScanner) Scan(destinations ...any) error {
	if len(destinations) != len(s.values) {
		return errors.New("unexpected destination count")
	}
	for index := range destinations {
		value := reflect.ValueOf(destinations[index])
		if value.Kind() != reflect.Pointer {
			return errors.New("destination is not a pointer")
		}
		source := reflect.ValueOf(s.values[index])
		if source.Type().AssignableTo(value.Elem().Type()) {
			value.Elem().Set(source)
			continue
		}
		if !source.Type().ConvertibleTo(value.Elem().Type()) {
			return errors.New("incompatible scan value")
		}
		value.Elem().Set(source.Convert(value.Elem().Type()))
	}
	return nil
}

type errorScanner struct {
	err error
}

func (s errorScanner) Scan(...any) error { return s.err }
