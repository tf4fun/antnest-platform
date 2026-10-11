package rpc

import (
	"time"

	"github.com/dlclark/regexp2"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

type contractRegexp struct{ *regexp2.Regexp }

func (r contractRegexp) MatchString(value string) bool {
	matched, err := r.Regexp.MatchString(value)
	return err == nil && matched
}

func newIdentitySchemaCompiler() *jsonschema.Compiler {
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
	return compiler
}
