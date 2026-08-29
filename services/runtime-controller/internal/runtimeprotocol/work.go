package runtimeprotocol

import (
	"context"
	"fmt"
	"path"
	"strings"
	"time"
	"unicode/utf8"
)

type WorkKind string

const (
	WorkKindRun         WorkKind = "run"
	WorkKindMaintenance WorkKind = "maintenance"
	// Work epochs cross the JSON boundary and therefore stay inside the exact
	// integer range shared by Go, Rust, and ordinary JSON implementations.
	MaxWorkEpoch          uint64 = 1<<53 - 1
	MaxFileContentBytes   int64  = 8 * 1024 * 1024
	MaxListDirEntries            = 4096
	MaxExecTimeout               = 24 * time.Hour
	MaxIdentityCharacters        = 160
)

func (k WorkKind) Validate() error {
	switch k {
	case WorkKindRun, WorkKindMaintenance:
		return nil
	default:
		return fmt.Errorf("invalid work kind %q", k)
	}
}

type WorkRef struct {
	WorkID        string `json:"work_id"`
	WorkEpoch     uint64 `json:"work_epoch"`
	WorkSessionID string `json:"work_session_id"`
}

func (r WorkRef) Validate() error {
	if strings.TrimSpace(r.WorkID) == "" || utf8.RuneCountInString(r.WorkID) > MaxIdentityCharacters {
		return fmt.Errorf("work id is required")
	}
	if r.WorkEpoch == 0 || r.WorkEpoch > MaxWorkEpoch {
		return fmt.Errorf("work epoch must be between 1 and %d", MaxWorkEpoch)
	}
	if strings.TrimSpace(r.WorkSessionID) == "" || utf8.RuneCountInString(r.WorkSessionID) > MaxIdentityCharacters {
		return fmt.Errorf("work session id is required")
	}
	return nil
}

type BeginWorkInput struct {
	WorkRef
	Kind WorkKind `json:"kind"`
}

func (i BeginWorkInput) Validate() error {
	if err := i.WorkRef.Validate(); err != nil {
		return err
	}
	return i.Kind.Validate()
}

type BeginWorkResult struct {
	Outcome
	Accepted bool `json:"accepted"`
}

func (r BeginWorkResult) Validate() error {
	if err := r.Outcome.Validate(); err != nil {
		return err
	}
	if r.Disposition != EffectCompleted && r.Accepted {
		return fmt.Errorf("unobserved work admission cannot be accepted")
	}
	return nil
}

type EndWorkInput struct {
	WorkRef
}

type EndWorkResult struct {
	Closed  bool   `json:"closed"`
	Reason  string `json:"reason"`
	Message string `json:"message,omitempty"`
}

func (r EndWorkResult) Validate() error {
	if strings.TrimSpace(r.Reason) == "" {
		return fmt.Errorf("work close reason is required")
	}
	if len(r.Message) > 4096 {
		return fmt.Errorf("work close message exceeds 4096 bytes")
	}
	return nil
}

type OperationRef struct {
	WorkRef
	OperationID   string `json:"operation_id"`
	RequestDigest string `json:"request_digest"`
}

func (r OperationRef) Validate() error {
	if err := r.WorkRef.Validate(); err != nil {
		return err
	}
	if strings.TrimSpace(r.OperationID) == "" || utf8.RuneCountInString(r.OperationID) > MaxIdentityCharacters {
		return fmt.Errorf("operation id is required")
	}
	if err := validateSHA256Digest(r.RequestDigest); err != nil {
		return fmt.Errorf("request digest: %w", err)
	}
	return nil
}

type RootName string

const (
	RootWorkspace    RootName = "workspace"
	RootSystemSkills RootName = "system_skills"
)

func (r RootName) Validate() error {
	switch r {
	case RootWorkspace, RootSystemSkills:
		return nil
	default:
		return fmt.Errorf("invalid named root %q", r)
	}
}

type RootPath struct {
	Root RootName `json:"root"`
	Path string   `json:"path"`
}

func (p RootPath) Validate() error {
	if err := p.Root.Validate(); err != nil {
		return err
	}
	if strings.TrimSpace(p.Path) == "" {
		return fmt.Errorf("root-relative path is required")
	}
	if strings.ContainsRune(p.Path, 0) {
		return fmt.Errorf("root-relative path contains NUL")
	}
	clean := path.Clean(p.Path)
	if strings.HasPrefix(p.Path, "/") || clean == ".." || strings.HasPrefix(clean, "../") ||
		containsParentSegment(p.Path) {
		return fmt.Errorf("path must stay relative to its named root")
	}
	return nil
}

func containsParentSegment(value string) bool {
	for _, segment := range strings.Split(value, "/") {
		if segment == ".." {
			return true
		}
	}
	return false
}

type EnvironmentVariable struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type ExecInput struct {
	OperationRef
	Argv       []string              `json:"argv"`
	WorkingDir RootPath              `json:"working_dir"`
	Env        []EnvironmentVariable `json:"env,omitempty"`
	Timeout    time.Duration         `json:"-"`
}

func (i ExecInput) Validate() error {
	if err := i.OperationRef.Validate(); err != nil {
		return err
	}
	if len(i.Argv) == 0 || strings.TrimSpace(i.Argv[0]) == "" {
		return fmt.Errorf("exec argv is required")
	}
	if err := i.WorkingDir.Validate(); err != nil {
		return fmt.Errorf("working directory: %w", err)
	}
	if i.WorkingDir.Root != RootWorkspace {
		return fmt.Errorf("process working directory must use workspace root")
	}
	if i.Timeout <= 0 || i.Timeout > MaxExecTimeout {
		return fmt.Errorf("exec timeout must be between 1ns and %s", MaxExecTimeout)
	}
	seen := make(map[string]struct{}, len(i.Env))
	for _, variable := range i.Env {
		name := strings.TrimSpace(variable.Name)
		if name == "" || strings.ContainsRune(name, '=') || strings.ContainsRune(name, 0) {
			return fmt.Errorf("environment variable name is invalid")
		}
		if _, ok := seen[name]; ok {
			return fmt.Errorf("environment variable %q is duplicated", name)
		}
		seen[name] = struct{}{}
	}
	return nil
}

type ExecResult struct {
	Outcome         Outcome `json:"outcome"`
	ExitCode        *int32  `json:"exit_code,omitempty"`
	Stdout          []byte  `json:"stdout,omitempty"`
	Stderr          []byte  `json:"stderr,omitempty"`
	ProcessReaped   bool    `json:"process_reaped"`
	ResultDigest    string  `json:"result_digest,omitempty"`
	Truncated       bool    `json:"truncated"`
	ProgressDropped bool    `json:"progress_dropped"`
}

func (r ExecResult) Validate() error {
	if err := r.Outcome.Validate(); err != nil {
		return err
	}
	if r.Outcome.Disposition == EffectCompleted && (r.ExitCode == nil || !r.ProcessReaped) {
		return fmt.Errorf("completed exec requires exit code and reaped process")
	}
	if r.Outcome.Disposition == EffectNotStarted &&
		(r.ExitCode != nil || r.ProcessReaped || len(r.Stdout) != 0 || len(r.Stderr) != 0) {
		return fmt.Errorf("not-started exec contains execution observations")
	}
	if r.ResultDigest != "" {
		if err := validateSHA256Digest(r.ResultDigest); err != nil {
			return fmt.Errorf("result digest: %w", err)
		}
	}
	return nil
}

type ReadFileInput struct {
	OperationRef
	Path   RootPath `json:"path"`
	Offset int64    `json:"offset"`
	Limit  int64    `json:"limit"`
}

func (i ReadFileInput) Validate() error {
	if err := i.OperationRef.Validate(); err != nil {
		return err
	}
	if err := i.Path.Validate(); err != nil {
		return err
	}
	if i.Offset < 0 || i.Limit <= 0 || i.Limit > MaxFileContentBytes {
		return fmt.Errorf("read offset and limit are invalid")
	}
	return nil
}

type ReadFileResult struct {
	Outcome      Outcome `json:"outcome"`
	Content      []byte  `json:"content,omitempty"`
	ResultDigest string  `json:"result_digest,omitempty"`
	Truncated    bool    `json:"truncated"`
}

func (r ReadFileResult) Validate() error {
	if err := r.Outcome.Validate(); err != nil {
		return err
	}
	if r.Outcome.Disposition == EffectNotStarted && len(r.Content) != 0 {
		return fmt.Errorf("not-started read contains content")
	}
	if r.ResultDigest != "" {
		if err := validateSHA256Digest(r.ResultDigest); err != nil {
			return fmt.Errorf("result digest: %w", err)
		}
	}
	return nil
}

type WriteFileInput struct {
	OperationRef
	Path    RootPath `json:"path"`
	Content []byte   `json:"content"`
}

func (i WriteFileInput) Validate() error {
	if err := i.OperationRef.Validate(); err != nil {
		return err
	}
	if err := i.Path.Validate(); err != nil {
		return err
	}
	if i.Path.Root != RootWorkspace {
		return fmt.Errorf("system Skill root is read-only")
	}
	if int64(len(i.Content)) > MaxFileContentBytes {
		return fmt.Errorf("write content exceeds %d bytes", MaxFileContentBytes)
	}
	return nil
}

type WriteFileResult struct {
	Outcome      Outcome `json:"outcome"`
	BytesWritten int64   `json:"bytes_written,omitempty"`
	ResultDigest string  `json:"result_digest,omitempty"`
}

type EditFileInput struct {
	OperationRef
	Path      RootPath `json:"path"`
	OldString string   `json:"old_string"`
	NewString string   `json:"new_string"`
}

func (i EditFileInput) Validate() error {
	if err := i.OperationRef.Validate(); err != nil {
		return err
	}
	if err := i.Path.Validate(); err != nil {
		return err
	}
	if i.Path.Root != RootWorkspace {
		return fmt.Errorf("system Skill root is read-only")
	}
	if i.OldString == "" {
		return fmt.Errorf("old_string is required")
	}
	if int64(len(i.OldString)) > MaxFileContentBytes || int64(len(i.NewString)) > MaxFileContentBytes {
		return fmt.Errorf("edit content exceeds %d bytes", MaxFileContentBytes)
	}
	return nil
}

type EditFileResult struct {
	Outcome      Outcome `json:"outcome"`
	BytesWritten int64   `json:"bytes_written,omitempty"`
	ResultDigest string  `json:"result_digest,omitempty"`
}

func (r EditFileResult) Validate() error {
	if err := r.Outcome.Validate(); err != nil {
		return err
	}
	if r.BytesWritten < 0 {
		return fmt.Errorf("bytes written must not be negative")
	}
	if r.Outcome.Disposition != EffectCompleted && r.BytesWritten != 0 {
		return fmt.Errorf("non-completed edit reports committed bytes")
	}
	if r.ResultDigest != "" {
		if err := validateSHA256Digest(r.ResultDigest); err != nil {
			return fmt.Errorf("result digest: %w", err)
		}
	}
	return nil
}

func (r WriteFileResult) Validate() error {
	if err := r.Outcome.Validate(); err != nil {
		return err
	}
	if r.BytesWritten < 0 {
		return fmt.Errorf("bytes written must not be negative")
	}
	if r.Outcome.Disposition != EffectCompleted && r.BytesWritten != 0 {
		return fmt.Errorf("non-completed write reports committed bytes")
	}
	if r.ResultDigest != "" {
		if err := validateSHA256Digest(r.ResultDigest); err != nil {
			return fmt.Errorf("result digest: %w", err)
		}
	}
	return nil
}

type ListDirInput struct {
	OperationRef
	Path  RootPath `json:"path"`
	Limit int      `json:"limit"`
}

func (i ListDirInput) Validate() error {
	if err := i.OperationRef.Validate(); err != nil {
		return err
	}
	if err := i.Path.Validate(); err != nil {
		return err
	}
	if i.Limit <= 0 || i.Limit > MaxListDirEntries {
		return fmt.Errorf("list limit must be between 1 and %d", MaxListDirEntries)
	}
	return nil
}

type DirectoryEntry struct {
	Name  string `json:"name"`
	IsDir bool   `json:"is_dir"`
	Size  int64  `json:"size"`
}

type ListDirResult struct {
	Outcome   Outcome          `json:"outcome"`
	Entries   []DirectoryEntry `json:"entries,omitempty"`
	Truncated bool             `json:"truncated"`
}

func (r ListDirResult) Validate() error {
	if err := r.Outcome.Validate(); err != nil {
		return err
	}
	if r.Outcome.Disposition == EffectNotStarted && len(r.Entries) != 0 {
		return fmt.Errorf("not-started list contains entries")
	}
	for _, entry := range r.Entries {
		if strings.TrimSpace(entry.Name) == "" || entry.Size < 0 {
			return fmt.Errorf("directory entry is invalid")
		}
	}
	return nil
}

type CancelOperationInput struct {
	WorkRef
	OperationID string `json:"operation_id"`
}

func (i CancelOperationInput) Validate() error {
	if err := i.WorkRef.Validate(); err != nil {
		return err
	}
	if strings.TrimSpace(i.OperationID) == "" || utf8.RuneCountInString(i.OperationID) > MaxIdentityCharacters {
		return fmt.Errorf("operation id is required")
	}
	return nil
}

type CancelOperationResult struct {
	Outcome Outcome `json:"outcome"`
}

func (r CancelOperationResult) Validate() error {
	return r.Outcome.Validate()
}

// WorkExecutor is the transport-independent execution boundary used by Agent
// and Server. Implementations must turn any post-admission transport failure
// into EffectUnknown rather than returning an ambiguous Go error.
type WorkExecutor interface {
	BeginWork(context.Context, GenerationKey, BeginWorkInput) BeginWorkResult
	EndWork(context.Context, GenerationKey, EndWorkInput) EndWorkResult
	Exec(context.Context, GenerationKey, ExecInput) ExecResult
	ReadFile(context.Context, GenerationKey, ReadFileInput) ReadFileResult
	WriteFile(context.Context, GenerationKey, WriteFileInput) WriteFileResult
	EditFile(context.Context, GenerationKey, EditFileInput) EditFileResult
	ListDir(context.Context, GenerationKey, ListDirInput) ListDirResult
	CancelOperation(context.Context, GenerationKey, CancelOperationInput) CancelOperationResult
}

func validateSHA256Digest(value string) error {
	const prefix = "sha256:"
	if !strings.HasPrefix(value, prefix) || len(value) != len(prefix)+64 {
		return fmt.Errorf("must use sha256:<64 lowercase hex characters>")
	}
	for _, character := range value[len(prefix):] {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return fmt.Errorf("must use sha256:<64 lowercase hex characters>")
		}
	}
	return nil
}
