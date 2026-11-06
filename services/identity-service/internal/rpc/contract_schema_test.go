package rpc

import (
	"bytes"
	"os"
	"testing"
	"time"

	"github.com/dlclark/regexp2"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

type contractRegexp struct{ *regexp2.Regexp }

func (r contractRegexp) MatchString(value string) bool {
	matched, err := r.Regexp.MatchString(value)
	return err == nil && matched
}

func newIdentitySchemaCompiler(t *testing.T) *jsonschema.Compiler {
	t.Helper()
	compiler := jsonschema.NewCompiler()
	// JSON Schema uses ECMAScript, including Unicode escapes. The library's
	// default Go regexp engine does not implement that contract dialect.
	compiler.UseRegexpEngine(func(pattern string) (jsonschema.Regexp, error) {
		compiled, err := regexp2.Compile(pattern, regexp2.ECMAScript)
		if err != nil {
			return nil, err
		}
		compiled.MatchTimeout = 100 * time.Millisecond
		return contractRegexp{compiled}, nil
	})
	pagination, err := os.ReadFile("../../../../contracts/common/pagination.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(pagination))
	if err != nil {
		t.Fatal(err)
	}
	if err := compiler.AddResource("https://schemas.antnest.dev/common/pagination.schema.json", document); err != nil {
		t.Fatal(err)
	}
	return compiler
}
