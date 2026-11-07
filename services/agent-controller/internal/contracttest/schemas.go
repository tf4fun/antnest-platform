package contracttest

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

var (
	compilerOnce  sync.Once
	shared        *jsonschema.Compiler
	compilerErr   error
	compilerMu    sync.Mutex
	manifestOnce  sync.Once
	goldenSchemas map[string]string
	manifestErr   error
)

func contractsRoot() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "../../../../contracts")
}

func loadCompiler() (*jsonschema.Compiler, error) {
	compilerOnce.Do(func() {
		compiler := jsonschema.NewCompiler()
		compiler.AssertFormat()
		compiler.UseLoader(deniedLoader{})
		compiler.UseRegexpEngine(func(pattern string) (jsonschema.Regexp, error) {
			if suffix := `(?![\s\S])`; strings.HasSuffix(pattern, suffix) {
				pattern = strings.TrimSuffix(pattern, suffix) + `\z`
			}
			return regexp.Compile(pattern)
		})
		compilerErr = filepath.WalkDir(contractsRoot(), func(path string, entry fs.DirEntry, err error) error {
			if err != nil || entry.IsDir() || !strings.HasSuffix(entry.Name(), ".schema.json") {
				return err
			}
			payload, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			var meta struct {
				ID string `json:"$id"`
			}
			if err := json.Unmarshal(payload, &meta); err != nil {
				return fmt.Errorf("parse %s: %w", path, err)
			}
			if meta.ID == "" {
				return fmt.Errorf("schema %s has no $id", path)
			}
			document, err := jsonschema.UnmarshalJSON(bytes.NewReader(payload))
			if err != nil {
				return fmt.Errorf("decode %s: %w", path, err)
			}
			return compiler.AddResource(meta.ID, document)
		})
		shared = compiler
	})
	return shared, compilerErr
}

func compileReference(reference string) (*jsonschema.Schema, error) {
	compilerMu.Lock()
	defer compilerMu.Unlock()
	return shared.Compile("https://schemas.antnest.dev/" + reference)
}

func Validate(t testing.TB, reference string, body []byte) {
	t.Helper()
	if _, err := loadCompiler(); err != nil {
		t.Fatalf("load schema registry: %v", err)
	}
	shape, err := compileReference(reference)
	if err != nil {
		t.Fatalf("compile %s: %v", reference, err)
	}
	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
	if err != nil {
		t.Fatalf("decode document for %s: %v", reference, err)
	}
	if err := shape.Validate(document); err != nil {
		t.Fatalf("schema %s rejected payload %s: %v", reference, string(body), err)
	}
}

func ValidateGolden(t testing.TB, relativeFilename string, body []byte) {
	t.Helper()
	manifestOnce.Do(func() {
		payload, err := os.ReadFile(filepath.Join(contractsRoot(), "golden-manifest.json"))
		if err != nil {
			manifestErr = err
			return
		}
		var entries []struct {
			File   string `json:"file"`
			Schema string `json:"schema"`
		}
		if err := json.Unmarshal(payload, &entries); err != nil {
			manifestErr = err
			return
		}
		goldenSchemas = map[string]string{}
		for _, entry := range entries {
			goldenSchemas[entry.File] = entry.Schema
		}
	})
	if manifestErr != nil {
		t.Fatalf("load golden manifest: %v", manifestErr)
	}
	reference, ok := goldenSchemas[relativeFilename]
	if !ok {
		t.Fatalf("no manifest entry for %s", relativeFilename)
	}
	Validate(t, reference, body)
}

type deniedLoader struct{}

func (deniedLoader) Load(url string) (any, error) {
	return nil, fmt.Errorf("unregistered schema reference %s", url)
}
