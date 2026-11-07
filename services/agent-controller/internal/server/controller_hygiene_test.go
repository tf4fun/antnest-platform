package server

import (
	"context"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

func TestControllerHygieneMainHandlerOwnsLearningPolicyRoutes(t *testing.T) {
	t.Parallel()
	boundary, err := newBusinessHandler(t,
		&catalogServiceStub{}, &lifecycleServiceStub{}, &agentConfigurationServiceStub{},
		&agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{},
		func(context.Context) error { return nil })
	require.NoError(t, err)

	read := httptest.NewRecorder()
	boundary.ServeHTTP(read, httptest.NewRequest(http.MethodGet,
		"/internal/agents/agent-1/skill-learning-policy?organization_id=org-1&principal_id=user-admin", nil))
	require.Equal(t, http.StatusOK, read.Code, read.Body.String())
	require.Equal(t, "no-store", read.Header().Get("Cache-Control"))
	require.Contains(t, read.Body.String(), `"mode":"automatic"`)

	write := httptest.NewRecorder()
	boundary.ServeHTTP(write, httptest.NewRequest(http.MethodPut,
		"/internal/agents/agent-1/skill-learning-policy",
		strings.NewReader(learningPolicyMutationJSON)))
	require.Equal(t, http.StatusOK, write.Code, write.Body.String())
	require.Equal(t, "no-store", write.Header().Get("Cache-Control"))
}

func TestControllerHygieneNewHandlerRejectsNilLearningPolicy(t *testing.T) {
	t.Parallel()
	f := newAuthenticationFixture(t)
	if _, err := NewHandler(&catalogServiceStub{}, &lifecycleServiceStub{}, &agentConfigurationServiceStub{},
		&agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{}, nil,
		func(context.Context) error { return nil }, f.security); err == nil {
		t.Fatal("constructor accepted a nil Skill learning policy service")
	}
}

func TestControllerHygieneLifecycleWireAppliesActivationCondition(t *testing.T) {
	t.Parallel()
	root := repositoryRoot(t)
	compiler := compileControlSchema(
		t, filepath.Join(root, "contracts/agent-controller/control-api.schema.json"),
	)
	now := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	states := []struct {
		name       string
		lifecycle  domain.AgentState
		activation domain.ActivationState
	}{
		{"created-enabled", domain.AgentCreated, domain.ActivationEnabled},
		{"created-disabled", domain.AgentCreated, domain.ActivationDisabled},
		{"not-created", domain.AgentNotCreated, ""},
		{"deleted", domain.AgentDeleted, ""},
	}
	for _, state := range states {
		t.Run(state.name, func(t *testing.T) {
			agent := sampleControlAgent(now)
			agent.LifecycleState, agent.ActivationState = state.lifecycle, state.activation
			queries := &agentQueryServiceStub{
				agent: agent, page: application.AgentPage{Items: []application.AgentView{agent}},
				workspacePage: application.WorkspaceAgentPage{Items: []application.WorkspaceAgentView{{
					AgentID: agent.AgentID, Name: agent.Name, LifecycleState: state.lifecycle,
					ActivationState: state.activation, RuntimeState: domain.RuntimeAvailable,
				}}},
			}
			boundary, err := newBusinessHandler(t,
				&catalogServiceStub{}, &lifecycleServiceStub{}, &agentConfigurationServiceStub{},
				queries, &agentEventServiceStub{}, &networkPolicyServiceStub{},
				func(context.Context) error { return nil })
			require.NoError(t, err)

			assertActivation := func(body []byte, label string) {
				t.Helper()
				has := strings.Contains(string(body), `"activation_state"`)
				if state.activation == "" && has {
					t.Fatalf("%s exposes activation_state for %s: %s", label, state.name, body)
				}
				if state.activation != "" && !has {
					t.Fatalf("%s omits activation_state for %s: %s", label, state.name, body)
				}
			}

			single := httptest.NewRecorder()
			boundary.ServeHTTP(single, httptest.NewRequest(http.MethodGet, "/internal/agents/agent-1?organization_id=org-1", nil))
			require.Equal(t, http.StatusOK, single.Code, single.Body.String())
			assertControlResponseSchema(t, compiler, "control-api.schema.json#/$defs/agent", single.Body.Bytes())
			assertActivation(single.Body.Bytes(), "get agent")

			list := httptest.NewRecorder()
			boundary.ServeHTTP(list, httptest.NewRequest(http.MethodGet, "/internal/agents?organization_id=org-1", nil))
			require.Equal(t, http.StatusOK, list.Code, list.Body.String())
			assertControlResponseSchema(t, compiler, "control-api.schema.json#/$defs/agent_list", list.Body.Bytes())
			assertActivation(list.Body.Bytes(), "list agents")

			workspace := httptest.NewRecorder()
			boundary.ServeHTTP(workspace, httptest.NewRequest(http.MethodPost, "/rpc/agent-controller/list-workspace-agents",
				strings.NewReader(`{"request_id":"workspace-1","organization_id":"org-1","principal_id":"user-admin"}`)))
			require.Equal(t, http.StatusOK, workspace.Code, workspace.Body.String())
			assertControlResponseSchema(t, compiler, "control-api.schema.json#/$defs/list_workspace_agents_response", workspace.Body.Bytes())
			assertActivation(workspace.Body.Bytes(), "workspace agents")
		})
	}
}

func controllerAPIErrorConstants(t *testing.T) map[string]string {
	t.Helper()
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, filepath.Join("..", "apierror", "errors.gen.go"), nil, 0)
	require.NoError(t, err)
	constants := map[string]string{}
	var previous []ast.Expr
	for _, declaration := range file.Decls {
		declaration, ok := declaration.(*ast.GenDecl)
		if !ok || declaration.Tok != token.CONST {
			continue
		}
		for _, spec := range declaration.Specs {
			values := spec.(*ast.ValueSpec)
			if len(values.Values) == 0 {
				values.Values = previous
			}
			previous = values.Values
			for i, name := range values.Names {
				if i >= len(values.Values) {
					continue
				}
				literal, ok := values.Values[i].(*ast.BasicLit)
				if !ok || literal.Kind != token.STRING {
					continue
				}
				code, err := strconv.Unquote(literal.Value)
				require.NoError(t, err)
				constants[name.Name] = code
			}
		}
	}
	return constants
}

func controllerHTTPStatusConstants(t *testing.T) map[string]int64 {
	t.Helper()
	root, err := exec.Command("go", "env", "GOROOT").Output()
	require.NoError(t, err)
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, filepath.Join(strings.TrimSpace(string(root)), "src", "net", "http", "status.go"), nil, 0)
	require.NoError(t, err)
	constants := map[string]int64{}
	for _, declaration := range file.Decls {
		declaration, ok := declaration.(*ast.GenDecl)
		if !ok || declaration.Tok != token.CONST {
			continue
		}
		for _, spec := range declaration.Specs {
			values := spec.(*ast.ValueSpec)
			for i, name := range values.Names {
				if i >= len(values.Values) {
					continue
				}
				literal, ok := values.Values[i].(*ast.BasicLit)
				if !ok || literal.Kind != token.INT {
					continue
				}
				status, err := strconv.ParseInt(literal.Value, 10, 64)
				require.NoError(t, err)
				constants[name.Name] = status
			}
		}
	}
	return constants
}

func writeErrorGateProblems(fset *token.FileSet, file *ast.File,
	apiCodes map[string]string, httpStatus map[string]int64, statusByCode map[string]int,
) []string {
	problems := []string{}
	resolveCode := func(expr ast.Expr, position token.Position) (string, bool) {
		switch arg := expr.(type) {
		case *ast.BasicLit:
			if arg.Kind != token.STRING {
				return "", false
			}
			code, err := strconv.Unquote(arg.Value)
			if err != nil {
				problems = append(problems, fmt.Sprintf("%s writeError code literal is invalid", position))
				return "", false
			}
			return code, true
		case *ast.SelectorExpr:
			if pkg, ok := arg.X.(*ast.Ident); ok && pkg.Name == "apierror" {
				code, declared := apiCodes[arg.Sel.Name]
				if !declared {
					problems = append(problems, fmt.Sprintf("%s writeError selector apierror.%s is undeclared", position, arg.Sel.Name))
					return "", false
				}
				return code, true
			}
		}
		return "", false
	}
	resolveStatus := func(expr ast.Expr, position token.Position) (int, bool) {
		switch arg := expr.(type) {
		case *ast.BasicLit:
			if arg.Kind != token.INT {
				return 0, false
			}
			status, err := strconv.Atoi(arg.Value)
			if err != nil {
				problems = append(problems, fmt.Sprintf("%s writeError status literal is invalid", position))
				return 0, false
			}
			return status, true
		case *ast.SelectorExpr:
			if pkg, ok := arg.X.(*ast.Ident); ok && pkg.Name == "http" {
				status, declared := httpStatus[arg.Sel.Name]
				if !declared {
					problems = append(problems, fmt.Sprintf("%s writeError selector http.%s is undeclared", position, arg.Sel.Name))
					return 0, false
				}
				return int(status), true
			}
		}
		return 0, false
	}
	ast.Inspect(file, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		fun, ok := call.Fun.(*ast.Ident)
		if !ok || fun.Name != "writeError" || len(call.Args) < 3 {
			return true
		}
		position := fset.Position(call.Pos())
		code, hasCode := resolveCode(call.Args[2], position)
		status, hasStatus := resolveStatus(call.Args[1], position)
		if !hasCode {
			return true
		}
		want, declared := statusByCode[code]
		if !declared {
			problems = append(problems, fmt.Sprintf("%s writeError code %q is not in the contract catalog", position, code))
			return true
		}
		if hasStatus && status != want {
			problems = append(problems, fmt.Sprintf("%s writeError code %q status=%d contract=%d", position, code, status, want))
		}
		return true
	})
	return problems
}

func TestControllerHygieneWriteErrorCodesMatchContract(t *testing.T) {
	t.Parallel()
	root := repositoryRoot(t)
	var contract machineControlContract
	readStrictContractJSON(t, filepath.Join(root, "contracts/agent-controller/control-contract.json"), &contract)
	require.NotEmpty(t, contract.Errors.StatusByCode)
	apiCodes := controllerAPIErrorConstants(t)
	require.NotEmpty(t, apiCodes)
	httpStatus := controllerHTTPStatusConstants(t)
	require.NotEmpty(t, httpStatus)

	check := func(name string, src any) []string {
		fset := token.NewFileSet()
		var file *ast.File
		var err error
		if src == nil {
			file, err = parser.ParseFile(fset, name, nil, 0)
		} else {
			file, err = parser.ParseFile(fset, name, src, 0)
		}
		require.NoError(t, err)
		return writeErrorGateProblems(fset, file, apiCodes, httpStatus, contract.Errors.StatusByCode)
	}

	entries, err := filepath.Glob("*.go")
	require.NoError(t, err)
	for _, path := range entries {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		if problems := check(path, nil); len(problems) != 0 {
			t.Fatalf("writeError catalog drift: %v", problems)
		}
	}

	require.Empty(t, check("fixture.go", `package fixture
func f() {
	writeError(nil, http.StatusConflict, apierror.PolicyRevisionConflict, "x", false)
	writeError(nil, 404, "preparation_not_found", "x", false)
	writeError(nil, http.StatusForbidden, code, "x", false)
}
`))
	require.Len(t, check("fixture.go", `package fixture
func f() {
	writeError(nil, 404, "not_a_contract_code", "x", false)
}
`), 1, "unknown literal code must be rejected")
	require.Len(t, check("fixture.go", `package fixture
func f() {
	writeError(nil, http.StatusConflict, apierror.NoSuchCode, "x", false)
}
`), 1, "undeclared apierror selector must be rejected")
	require.Len(t, check("fixture.go", `package fixture
func f() {
	writeError(nil, http.StatusOK, apierror.PolicyRevisionConflict, "x", false)
}
`), 1, "a status disagreeing with the catalog must be rejected")
}
