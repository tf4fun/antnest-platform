package runtimeprotocol

import (
	"strings"
	"testing"
	"time"
)

const testDigest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func TestOutcomeValidation(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		outcome Outcome
		wantErr bool
	}{
		{name: "completed", outcome: Outcome{Disposition: EffectCompleted, Reason: "exited"}},
		{name: "not started", outcome: Outcome{Disposition: EffectNotStarted, Reason: "busy"}},
		{name: "unknown", outcome: Outcome{Disposition: EffectUnknown, Reason: "transport_lost"}},
		{name: "missing disposition", outcome: Outcome{Reason: "exited"}, wantErr: true},
		{name: "missing reason", outcome: Outcome{Disposition: EffectCompleted}, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if err := test.outcome.Validate(); (err != nil) != test.wantErr {
				t.Fatalf("Validate() error = %v, wantErr %v", err, test.wantErr)
			}
		})
	}
}

func TestWorkFencingValidation(t *testing.T) {
	t.Parallel()

	valid := WorkRef{WorkID: "run-1", WorkEpoch: 7, WorkSessionID: "session-1"}
	if err := valid.Validate(); err != nil {
		t.Fatalf("valid work ref: %v", err)
	}

	tests := []WorkRef{
		{WorkEpoch: 7, WorkSessionID: "session-1"},
		{WorkID: "run-1", WorkSessionID: "session-1"},
		{WorkID: "run-1", WorkEpoch: 7},
		{WorkID: strings.Repeat("界", MaxIdentityCharacters+1), WorkEpoch: 7, WorkSessionID: "session-1"},
		{WorkID: "run-1", WorkEpoch: 7, WorkSessionID: strings.Repeat("界", MaxIdentityCharacters+1)},
	}
	for _, test := range tests {
		if err := test.Validate(); err == nil {
			t.Fatalf("invalid work ref accepted: %#v", test)
		}
	}
}

func TestWorkEpochStaysJSONSafe(t *testing.T) {
	t.Parallel()

	for _, epoch := range []uint64{0, MaxWorkEpoch + 1} {
		input := BeginWorkInput{
			WorkRef: WorkRef{WorkID: "run-1", WorkEpoch: epoch, WorkSessionID: "session-1"},
			Kind:    WorkKindRun,
		}
		if err := input.Validate(); err == nil {
			t.Fatalf("unsafe work epoch %d was accepted", epoch)
		}
	}
}

func TestWorkResultDiagnosticsDoNotChangeReason(t *testing.T) {
	t.Parallel()

	rejected := BeginWorkResult{Outcome: Outcome{
		Disposition: EffectUnknown, Reason: "runtime_unavailable", Message: strings.Repeat("x", 4097),
	}}
	if err := rejected.Validate(); err == nil {
		t.Fatal("oversized work admission message was accepted")
	}
	closed := EndWorkResult{Reason: "containment_failed", Message: strings.Repeat("x", 4097)}
	if err := closed.Validate(); err == nil {
		t.Fatal("oversized work close message was accepted")
	}
}

func TestExecInputValidation(t *testing.T) {
	t.Parallel()

	input := ExecInput{
		OperationRef: OperationRef{
			WorkRef:       WorkRef{WorkID: "run-1", WorkEpoch: 7, WorkSessionID: "session-1"},
			OperationID:   "tool-1/0",
			RequestDigest: testDigest,
		},
		Argv:       []string{"sh", "-lc", "printf ok"},
		WorkingDir: RootPath{Root: RootWorkspace, Path: "."},
		Env:        []EnvironmentVariable{{Name: "LANG", Value: "C.UTF-8"}},
		Timeout:    time.Minute,
	}
	if err := input.Validate(); err != nil {
		t.Fatalf("valid exec input: %v", err)
	}

	input.Env = append(input.Env, EnvironmentVariable{Name: "LANG", Value: "C"})
	if err := input.Validate(); err == nil || !strings.Contains(err.Error(), "duplicated") {
		t.Fatalf("duplicate environment variable error = %v", err)
	}
}

func TestMethodSpecificResultValidation(t *testing.T) {
	t.Parallel()

	exitCode := int32(0)
	if err := (ExecResult{
		Outcome:       Outcome{Disposition: EffectCompleted, Reason: "exited"},
		ExitCode:      &exitCode,
		ProcessReaped: true,
		ResultDigest:  testDigest,
	}).Validate(); err != nil {
		t.Fatalf("valid completed exec: %v", err)
	}

	if err := (ExecResult{
		Outcome: Outcome{Disposition: EffectCompleted, Reason: "exited"},
	}).Validate(); err == nil {
		t.Fatal("completed exec without observed exit was accepted")
	}

	if err := (WriteFileResult{
		Outcome:      Outcome{Disposition: EffectUnknown, Reason: "transport_lost"},
		BytesWritten: 10,
	}).Validate(); err == nil {
		t.Fatal("unknown write with committed byte count was accepted")
	}

	if err := (ReadFileResult{
		Outcome: Outcome{Disposition: EffectNotStarted, Reason: "stale_work"},
		Content: []byte("impossible"),
	}).Validate(); err == nil {
		t.Fatal("not-started read with content was accepted")
	}
}

func TestSystemSkillsAreReadOnly(t *testing.T) {
	t.Parallel()

	input := WriteFileInput{
		OperationRef: OperationRef{
			WorkRef:       WorkRef{WorkID: "run-1", WorkEpoch: 7, WorkSessionID: "session-1"},
			OperationID:   "tool-1/0",
			RequestDigest: testDigest,
		},
		Path: RootPath{Root: RootSystemSkills, Path: "example/SKILL.md"},
	}
	if err := input.Validate(); err == nil {
		t.Fatal("write to system Skill root was accepted")
	}
	edit := EditFileInput{
		OperationRef: input.OperationRef,
		Path:         input.Path,
		OldString:    "before",
		NewString:    "after",
	}
	if err := edit.Validate(); err == nil {
		t.Fatal("edit to system Skill root was accepted")
	}
}

func TestEditFileRequiresExactSearchTextAndConsistentResult(t *testing.T) {
	t.Parallel()

	input := EditFileInput{
		OperationRef: OperationRef{
			WorkRef:       WorkRef{WorkID: "run-1", WorkEpoch: 7, WorkSessionID: "session-1"},
			OperationID:   "tool-1/0",
			RequestDigest: testDigest,
		},
		Path: RootPath{Root: RootWorkspace, Path: "notes.txt"},
	}
	if err := input.Validate(); err == nil {
		t.Fatal("edit without old_string was accepted")
	}
	input.OldString = "before"
	input.NewString = "after"
	if err := input.Validate(); err != nil {
		t.Fatalf("valid edit input: %v", err)
	}
	if err := (EditFileResult{
		Outcome:      Outcome{Disposition: EffectUnknown, Reason: "transport_lost"},
		BytesWritten: 10,
	}).Validate(); err == nil {
		t.Fatal("unknown edit with committed byte count was accepted")
	}
}

func TestRootPathRejectsEscape(t *testing.T) {
	t.Parallel()

	for _, value := range []string{"/etc/passwd", "../outside", "a/../../outside", "a/../inside"} {
		rootPath := RootPath{Root: RootWorkspace, Path: value}
		if err := rootPath.Validate(); err == nil {
			t.Fatalf("escaping path %q was accepted", value)
		}
	}
}
