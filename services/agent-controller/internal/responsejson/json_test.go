package responsejson

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

type envelope struct {
	Name   string          `json:"name"`
	Count  int             `json:"count"`
	Inner  inner           `json:"inner"`
	Items  []item          `json:"items"`
	Meta   map[string]any  `json:"meta"`
	Raw    json.RawMessage `json:"raw"`
	Tagged *inner          `json:"tagged"`
	Next   *envelope       `json:"next"`
	Any    any             `json:"any"`
}

type inner struct {
	Value  string `json:"value"`
	Marker int    `json:"marker"`
}

type item struct {
	Label string `json:"label"`
}

type embeddedEnvelope struct {
	inner
	Outer string `json:"outer"`
}

func TestDecodeProjectsOnlyDeclaredResponseFields(t *testing.T) {
	raw := []byte(`{"name":"kept","NAME":"alias-dropped","count":3,"Count":9,` +
		`"inner":{"value":"nested","marker":1,"extension":{"deep":[1,2]}},` +
		`"items":[{"label":"a","extra":true},{"label":"b","unknown":{"x":1}}],` +
		`"meta":{"arbitrary":{"nested":"preserved"}},"raw":{"verbatim":[1,"two"]},"tagged":{"value":"ptr","extension":2},` +
		`"next":{"name":"child","inner":{"value":"deep","extension":4}},` +
		`"any":{"free":"form"},"top_extension":"dropped"}`)
	var decoded envelope
	require.NoError(t, Decode(raw, &decoded))
	require.Equal(t, "kept", decoded.Name)
	require.Equal(t, 3, decoded.Count)
	require.Equal(t, inner{Value: "nested", Marker: 1}, decoded.Inner)
	require.Equal(t, []item{{Label: "a"}, {Label: "b"}}, decoded.Items)
	require.Equal(t, map[string]any{"arbitrary": map[string]any{"nested": "preserved"}}, decoded.Meta)
	require.JSONEq(t, `{"verbatim":[1,"two"]}`, string(decoded.Raw))
	require.Equal(t, &inner{Value: "ptr"}, decoded.Tagged)
	require.Equal(t, "child", decoded.Next.Name)
	require.Equal(t, inner{Value: "deep"}, decoded.Next.Inner)
	require.Equal(t, map[string]any{"free": "form"}, decoded.Any)
}

func TestDecodeFlattensEmbeddedExportedStructs(t *testing.T) {
	var decoded embeddedEnvelope
	require.NoError(t, Decode([]byte(`{"outer":"shell","value":"embedded","marker":2,"extension":1}`), &decoded))
	require.Equal(t, embeddedEnvelope{Outer: "shell", inner: inner{Value: "embedded", Marker: 2}}, decoded)
}

type opaqueScalar string

func (scalar *opaqueScalar) UnmarshalJSON(raw []byte) error {
	*scalar = opaqueScalar(raw)
	return nil
}

func TestDecodePassesNonObjectScalarsToCustomUnmarshalers(t *testing.T) {
	var decoded struct {
		Label opaqueScalar `json:"label"`
	}
	require.NoError(t, Decode([]byte(`{"label":"scalar-value","extra":1}`), &decoded))
	require.Equal(t, opaqueScalar(`"scalar-value"`), decoded.Label)
}

func TestDecodeRejectsDuplicateTrailingAndNonUTF8Documents(t *testing.T) {
	var decoded inner
	for name, raw := range map[string][]byte{
		"duplicate member":  []byte(`{"value":"a","value":"b"}`),
		"trailing document": []byte(`{"value":"a"} {"value":"b"}`),
		"trailing bytes":    []byte(`{"value":"a"}x`),
		"non object":        []byte(`[1,2]`),
		"invalid utf8":      []byte{'{', '"', 'v', 'a', 'l', 'u', 'e', '"', ':', '"', 0xff, '"', '}'},
	} {
		t.Run(name, func(t *testing.T) {
			require.Error(t, Decode(raw, &decoded), string(raw))
		})
	}
}

func TestDecodeStillRequiresKnownFieldsToHaveValidValues(t *testing.T) {
	var decoded inner
	require.Error(t, Decode([]byte(`{"value":{"not":"a string"},"marker":1}`), &decoded))
	require.Error(t, Decode([]byte(`{"marker":"not-a-number"}`), &decoded))
}
