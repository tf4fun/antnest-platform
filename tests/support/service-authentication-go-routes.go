//go:build ignore

// Repository verification only. Parse Go route registrations without importing
// service implementations, opening listeners, or constructing dependencies.
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

type values []any
type environment map[string]values
type contextArgument struct{}
type unresolvedArgument struct{}
type exportedParameter struct{}

type result struct {
	Routes []string `json:"routes"`
	Errors []string `json:"errors"`
}

type scanner struct {
	file   *ast.File
	files  []*ast.File
	set    *token.FileSet
	path   string
	routes map[string]bool
	errors []string
}

func functionName(expression ast.Expr) string {
	switch value := expression.(type) {
	case *ast.Ident:
		return value.Name
	case *ast.SelectorExpr:
		return value.Sel.Name
	}
	return ""
}

func (s *scanner) evaluate(expression ast.Expr, env environment) values {
	switch value := expression.(type) {
	case *ast.BasicLit:
		if value.Kind == token.STRING {
			text, err := strconv.Unquote(value.Value)
			if err == nil {
				return values{text}
			}
		}
	case *ast.Ident:
		return env[value.Name]
	case *ast.SelectorExpr:
		if base, ok := value.X.(*ast.Ident); ok && base.Name == "http" && strings.HasPrefix(value.Sel.Name, "Method") {
			return values{strings.ToUpper(strings.TrimPrefix(value.Sel.Name, "Method"))}
		}
		var output values
		for _, base := range s.evaluate(value.X, env) {
			if row, ok := base.(map[string]values); ok {
				output = append(output, row[value.Sel.Name]...)
			} else if _, exported := base.(exportedParameter); exported {
				output = append(output, exportedParameter{})
			} else {
				output = append(output, unresolvedArgument{})
			}
		}
		return output
	case *ast.BinaryExpr:
		if value.Op != token.ADD {
			return nil
		}
		var output values
		for _, left := range s.evaluate(value.X, env) {
			for _, right := range s.evaluate(value.Y, env) {
				a, aOK := left.(string)
				b, bOK := right.(string)
				_, leftExported := left.(exportedParameter)
				_, rightExported := right.(exportedParameter)
				if leftExported || rightExported {
					output = append(output, exportedParameter{})
				} else if aOK && bOK {
					output = append(output, a+b)
				} else {
					output = append(output, unresolvedArgument{})
				}
			}
		}
		return output
	case *ast.CompositeLit:
		var fieldNames []string
		if rowType, ok := value.Type.(*ast.StructType); ok {
			for _, field := range rowType.Fields.List {
				for _, name := range field.Names {
					fieldNames = append(fieldNames, name.Name)
				}
			}
		}
		if arrayType, ok := value.Type.(*ast.ArrayType); ok {
			if rowType, ok := arrayType.Elt.(*ast.StructType); ok {
				for _, field := range rowType.Fields.List {
					for _, name := range field.Names {
						fieldNames = append(fieldNames, name.Name)
					}
				}
			}
			var output values
			for _, element := range value.Elts {
				if row, ok := element.(*ast.CompositeLit); ok && len(fieldNames) > 0 {
					fields := map[string]values{}
					for i, field := range row.Elts {
						if i < len(fieldNames) {
							fields[fieldNames[i]] = s.evaluate(field, env)
						}
					}
					output = append(output, fields)
				} else {
					output = append(output, s.evaluate(element, env)...)
				}
			}
			return output
		}
		row := map[string]values{}
		for i, element := range value.Elts {
			if field, ok := element.(*ast.KeyValueExpr); ok {
				if key, ok := field.Key.(*ast.Ident); ok {
					row[key.Name] = s.evaluate(field.Value, env)
				}
			} else if i < len(fieldNames) {
				row[fieldNames[i]] = s.evaluate(element, env)
			}
		}
		return values{row}
	case *ast.CallExpr:
		// The Controller stores routes in a literal-returning routes() method.
		name := functionName(value.Fun)
		for _, file := range s.files {
			for _, declaration := range file.Decls {
				fn, ok := declaration.(*ast.FuncDecl)
				if !ok || fn.Name.Name != name || len(value.Args) != 0 || fn.Body == nil {
					continue
				}
				for _, statement := range fn.Body.List {
					returned, ok := statement.(*ast.ReturnStmt)
					if ok && len(returned.Results) == 1 {
						if _, literal := returned.Results[0].(*ast.CompositeLit); literal {
							return s.evaluate(returned.Results[0], env)
						}
					}
				}
			}
		}
	}
	return nil
}

type visitor struct {
	scanner *scanner
	env     environment
}

func cloneEnvironment(env environment) environment {
	copy := environment{}
	for name, value := range env {
		copy[name] = value
	}
	return copy
}

func (v visitor) Visit(node ast.Node) ast.Visitor {
	if node == nil {
		return nil
	}
	s := v.scanner
	switch value := node.(type) {
	case *ast.AssignStmt:
		for index, left := range value.Lhs {
			if index < len(value.Rhs) {
				if name, ok := left.(*ast.Ident); ok {
					for _, evaluated := range s.evaluate(value.Rhs[index], v.env) {
						if _, exported := evaluated.(exportedParameter); exported {
							v.env[name.Name] = values{exportedParameter{}}
						}
					}
				}
			}
		}
	case *ast.ValueSpec:
		for index, name := range value.Names {
			if index < len(value.Values) {
				for _, evaluated := range s.evaluate(value.Values[index], v.env) {
					if _, exported := evaluated.(exportedParameter); exported {
						v.env[name.Name] = values{exportedParameter{}}
					}
				}
			}
		}
	case *ast.FuncLit:
		// Resolve a locally named pattern wrapper through its own call sites.
		// Never accidentally substitute another wrapper's registration list.
		if len(value.Type.Params.List) > 0 && len(value.Type.Params.List[0].Names) == 1 && value.Type.Params.List[0].Names[0].Name == "pattern" {
			env := cloneEnvironment(v.env)
			name := ""
			ast.Inspect(s.file, func(node ast.Node) bool {
				assignment, ok := node.(*ast.AssignStmt)
				if ok {
					for i, expression := range assignment.Rhs {
						if expression == value && i < len(assignment.Lhs) {
							if identifier, ok := assignment.Lhs[i].(*ast.Ident); ok {
								name = identifier.Name
							}
						}
					}
				}
				return true
			})
			// A local closure is not a package-level function.
			env["pattern"] = s.callArguments(name, 0, []*ast.File{s.file})
			ast.Walk(visitor{s, env}, value.Body)
			return nil
		}
	case *ast.FuncDecl:
		env := cloneEnvironment(v.env)
		index := 0
		for _, parameter := range value.Type.Params.List {
			for _, name := range parameter.Names {
				env[name.Name] = s.callArguments(value.Name.Name, index, s.files)
				// Known calls in this package cannot cover external callers of an
				// exported wrapper. Track its own parameters instead of substituting
				// local literals; fixed registrations and local closures still work.
				if token.IsExported(value.Name.Name) {
					env[name.Name] = values{exportedParameter{}}
				}
				if selector, ok := parameter.Type.(*ast.SelectorExpr); ok && selector.Sel.Name == "Context" {
					if qualifier, ok := selector.X.(*ast.Ident); ok && qualifier.Name == "context" {
						env[name.Name] = values{contextArgument{}}
					}
				}
				index++
			}
		}
		if value.Body != nil {
			ast.Walk(visitor{s, env}, value.Body)
		}
		return nil
	case *ast.RangeStmt:
		items := s.evaluate(value.X, v.env)
		if len(items) == 0 {
			// Do not hide a new or unsupported registration loop.
			ast.Walk(visitor{s, cloneEnvironment(v.env)}, value.Body)
			return nil
		}
		for _, item := range items {
			env := cloneEnvironment(v.env)
			if name, ok := value.Value.(*ast.Ident); ok {
				env[name.Name] = values{item}
			}
			ast.Walk(visitor{s, env}, value.Body)
		}
		return nil
	case *ast.IfStmt:
		if condition, ok := value.Cond.(*ast.BinaryExpr); ok && (condition.Op == token.EQL || condition.Op == token.NEQ) {
			left, right := s.evaluate(condition.X, v.env), s.evaluate(condition.Y, v.env)
			if len(left) == 1 && len(right) == 1 {
				a, aOK := left[0].(string)
				b, bOK := right[0].(string)
				if aOK && bOK {
					if (a == b) == (condition.Op == token.EQL) {
						ast.Walk(v, value.Body)
					} else if value.Else != nil {
						ast.Walk(v, value.Else)
					}
					return nil
				}
			}
		}
	case *ast.CallExpr:
		name := functionName(value.Fun)
		if name != "Handle" && name != "HandleFunc" {
			return v
		}
		selector, ok := value.Fun.(*ast.SelectorExpr)
		if !ok || len(value.Args) != 2 {
			return v
		}
		// slog.Handler.Handle takes context and record, not a mux pattern.
		if base, ok := selector.X.(*ast.SelectorExpr); ok && base.Sel.Name == "next" {
			return v
		}
		patterns := s.evaluate(value.Args[0], v.env)
		if name == "Handle" && len(patterns) == 1 {
			if _, isContext := patterns[0].(contextArgument); isContext {
				return v // slog.Handler.Handle(context.Context, slog.Record).
			}
		}
		if len(patterns) == 0 {
			s.errors = append(s.errors, fmt.Sprintf("%s:%d unresolved registration", s.path, s.set.Position(value.Pos()).Line))
		}
		for _, pattern := range patterns {
			if _, exported := pattern.(exportedParameter); exported {
				s.errors = append(s.errors, fmt.Sprintf("%s:%d exported route wrapper forwards a route-pattern parameter", s.path, s.set.Position(value.Pos()).Line))
				continue
			}
			text, ok := pattern.(string)
			if !ok || (!strings.HasPrefix(text, "/") && !strings.Contains(text, " /")) {
				s.errors = append(s.errors, fmt.Sprintf("%s:%d unresolved registration", s.path, s.set.Position(value.Pos()).Line))
				continue
			}
			if strings.HasPrefix(text, "/") {
				text = "* " + text
			}
			s.routes[text] = true
		}
	}
	return v
}

func (s *scanner) callArguments(name string, index int, files []*ast.File) values {
	var output values
	for _, file := range files {
		ast.Inspect(file, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok || functionName(call.Fun) != name {
				return true
			}
			var arguments values
			if index < len(call.Args) {
				arguments = s.evaluate(call.Args[index], environment{})
			}
			if len(arguments) == 0 {
				// Keep an unresolved invocation even when another call is static.
				// Otherwise the known call would silently cover the unknown one.
				arguments = values{unresolvedArgument{}}
			}
			output = append(output, arguments...)
			return true
		})
	}
	return output
}

func main() {
	sources := map[string]string{}
	if err := json.NewDecoder(os.Stdin).Decode(&sources); err != nil {
		fmt.Fprintln(os.Stderr, "invalid route scanner input")
		os.Exit(1)
	}
	output := map[string]result{}
	set := token.NewFileSet()
	packages := map[string][]*ast.File{}
	files := map[string]*ast.File{}
	var paths []string
	for path := range sources {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	packageKey := func(path string, file *ast.File) string {
		return filepath.Dir(path) + "\x00" + file.Name.Name
	}
	for _, path := range paths {
		file, err := parser.ParseFile(set, path, sources[path], 0)
		if err != nil {
			output[path] = result{Routes: []string{}, Errors: []string{path + ": Go parse failed"}}
			continue
		}
		files[path] = file
		key := packageKey(path, file)
		packages[key] = append(packages[key], file)
	}
	for _, path := range paths {
		file := files[path]
		if file == nil {
			continue
		}
		s := &scanner{
			file: file, files: packages[packageKey(path, file)], set: set, path: path,
			routes: map[string]bool{}, errors: []string{},
		}
		ast.Walk(visitor{s, environment{}}, file)
		routes := []string{}
		for route := range s.routes {
			routes = append(routes, route)
		}
		sort.Strings(routes)
		sort.Strings(s.errors)
		output[path] = result{Routes: routes, Errors: s.errors}
	}
	if err := json.NewEncoder(os.Stdout).Encode(output); err != nil {
		os.Exit(1)
	}
}
