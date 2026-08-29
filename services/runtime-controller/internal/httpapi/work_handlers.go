package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"time"

	runtimecontracts "soft/antnest-platform/services/runtime-controller/internal/runtimeprotocol"
)

type WorkService interface {
	BeginWork(context.Context, string, runtimecontracts.BeginWorkInput) (runtimecontracts.BeginWorkResult, error)
	EndWork(context.Context, string, runtimecontracts.EndWorkInput) (runtimecontracts.EndWorkResult, error)
	Exec(context.Context, string, runtimecontracts.ExecInput) (runtimecontracts.ExecResult, error)
	ReadFile(context.Context, string, runtimecontracts.ReadFileInput) (runtimecontracts.ReadFileResult, error)
	WriteFile(context.Context, string, runtimecontracts.WriteFileInput) (runtimecontracts.WriteFileResult, error)
	EditFile(context.Context, string, runtimecontracts.EditFileInput) (runtimecontracts.EditFileResult, error)
	ListDir(context.Context, string, runtimecontracts.ListDirInput) (runtimecontracts.ListDirResult, error)
	CancelOperation(context.Context, string, runtimecontracts.CancelOperationInput) (runtimecontracts.CancelOperationResult, error)
}

func (h *Handler) beginWork(response http.ResponseWriter, request *http.Request) {
	handleWork(response, request, h.work.BeginWork, func(input runtimecontracts.BeginWorkInput) error {
		return input.Validate()
	})
}

func (h *Handler) endWork(response http.ResponseWriter, request *http.Request) {
	handleWork(response, request, h.work.EndWork, func(input runtimecontracts.EndWorkInput) error {
		return input.Validate()
	})
}

func (h *Handler) readFile(response http.ResponseWriter, request *http.Request) {
	handleWork(response, request, h.work.ReadFile, func(input runtimecontracts.ReadFileInput) error {
		return input.Validate()
	})
}

func (h *Handler) writeFile(response http.ResponseWriter, request *http.Request) {
	handleWork(response, request, h.work.WriteFile, func(input runtimecontracts.WriteFileInput) error {
		return input.Validate()
	})
}

func (h *Handler) editFile(response http.ResponseWriter, request *http.Request) {
	handleWork(response, request, h.work.EditFile, func(input runtimecontracts.EditFileInput) error {
		return input.Validate()
	})
}

func (h *Handler) listDir(response http.ResponseWriter, request *http.Request) {
	handleWork(response, request, h.work.ListDir, func(input runtimecontracts.ListDirInput) error {
		return input.Validate()
	})
}

func (h *Handler) cancelOperation(response http.ResponseWriter, request *http.Request) {
	handleWork(response, request, h.work.CancelOperation, func(input runtimecontracts.CancelOperationInput) error {
		return input.Validate()
	})
}

func handleWork[Input any, Output any](
	response http.ResponseWriter,
	request *http.Request,
	execute func(context.Context, string, Input) (Output, error),
	validate func(Input) error,
) {
	var input Input
	if !decodeJSON(response, request, &input) {
		return
	}
	if err := validate(input); err != nil {
		writeProblem(response, request, http.StatusBadRequest, "invalid_work_request", err.Error())
		return
	}
	result, err := execute(request.Context(), request.PathValue("agent_id"), input)
	if err != nil {
		writeServiceError(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, result)
}

type execRequest struct {
	runtimecontracts.OperationRef
	Argv       []string                               `json:"argv"`
	WorkingDir runtimecontracts.RootPath              `json:"working_dir"`
	Env        []runtimecontracts.EnvironmentVariable `json:"env,omitempty"`
	TimeoutMS  uint64                                 `json:"timeout_ms"`
}

func (h *Handler) exec(response http.ResponseWriter, request *http.Request) {
	var body execRequest
	if !decodeJSON(response, request, &body) {
		return
	}
	if body.TimeoutMS == 0 || body.TimeoutMS > uint64(runtimecontracts.MaxExecTimeout/time.Millisecond) {
		writeProblem(response, request, http.StatusBadRequest, "invalid_work_request", fmt.Sprintf(
			"timeout_ms must be between 1 and %d", runtimecontracts.MaxExecTimeout/time.Millisecond,
		))
		return
	}
	input := runtimecontracts.ExecInput{
		OperationRef: body.OperationRef, Argv: body.Argv, WorkingDir: body.WorkingDir,
		Env: body.Env, Timeout: time.Duration(body.TimeoutMS) * time.Millisecond,
	}
	if err := input.Validate(); err != nil {
		writeProblem(response, request, http.StatusBadRequest, "invalid_work_request", err.Error())
		return
	}
	result, err := h.work.Exec(request.Context(), request.PathValue("agent_id"), input)
	if err != nil {
		writeServiceError(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, result)
}
