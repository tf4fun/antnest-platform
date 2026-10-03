package serviceauth

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"reflect"
	"strings"
	"unicode/utf8"
)

// DecodeObject rejects duplicate decoded keys before Go's map/struct decoder
// can overwrite them. It also rejects invalid UTF-8, BOM and extra documents.
func DecodeObject(raw []byte, target any) error {
	if !utf8.Valid(raw) {
		return fmt.Errorf("invalid JSON UTF-8")
	}
	scanner := json.NewDecoder(bytes.NewReader(raw))
	scanner.UseNumber()
	first, err := scanner.Token()
	if err != nil || first != json.Delim('{') {
		return fmt.Errorf("JSON object required")
	}
	if err := scanObject(scanner, 0); err != nil {
		return err
	}
	if _, err := scanner.Token(); err != io.EOF {
		return fmt.Errorf("one JSON document required")
	}
	if err := exactFields(raw, reflect.TypeOf(target)); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	return decoder.Decode(target)
}

// encoding/json matches struct fields case-insensitively. Wire contracts do
// not: reject aliases before decoding so two distinct names cannot overwrite
// one authorization field. Raw JSON and dynamic maps retain their own rules.
func exactFields(raw []byte, kind reflect.Type) error {
	if kind == nil {
		return fmt.Errorf("JSON target required")
	}
	for kind.Kind() == reflect.Pointer {
		kind = kind.Elem()
	}
	if kind == reflect.TypeFor[json.RawMessage]() {
		return nil
	}
	if kind.Kind() == reflect.Slice || kind.Kind() == reflect.Array {
		if kind.Elem().Kind() == reflect.Uint8 {
			return nil
		}
		var elements []json.RawMessage
		if json.Unmarshal(raw, &elements) != nil {
			return fmt.Errorf("JSON array required")
		}
		for _, element := range elements {
			if err := exactFields(element, kind.Elem()); err != nil {
				return err
			}
		}
	}
	if kind.Kind() != reflect.Struct {
		return nil
	}
	fields := make(map[string]reflect.Type)
	collectFields(kind, fields)
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil {
		return fmt.Errorf("JSON object required")
	}
	for name, value := range object {
		field, known := fields[name]
		if !known {
			return fmt.Errorf("unknown JSON member")
		}
		if err := exactFields(value, field); err != nil {
			return err
		}
	}
	return nil
}

func collectFields(kind reflect.Type, fields map[string]reflect.Type) {
	for index := 0; index < kind.NumField(); index++ {
		field := kind.Field(index)
		if field.Anonymous {
			embedded := field.Type
			for embedded.Kind() == reflect.Pointer {
				embedded = embedded.Elem()
			}
			if embedded.Kind() == reflect.Struct {
				collectFields(embedded, fields)
				continue
			}
		}
		name := strings.Split(field.Tag.Get("json"), ",")[0]
		if name == "-" || !field.IsExported() {
			continue
		}
		if name == "" {
			name = field.Name
		}
		fields[name] = field.Type
	}
}

func scanObject(decoder *json.Decoder, depth int) error {
	seen := make(map[string]bool)
	for decoder.More() {
		token, err := decoder.Token()
		name, ok := token.(string)
		if err != nil || !ok || seen[name] {
			return fmt.Errorf("invalid or duplicate JSON member")
		}
		seen[name] = true
		if err := scanValue(decoder, depth+1); err != nil {
			return err
		}
	}
	last, err := decoder.Token()
	if err != nil || last != json.Delim('}') {
		return fmt.Errorf("invalid JSON object")
	}
	return nil
}

func scanValue(decoder *json.Decoder, depth int) error {
	if depth > 32 {
		return fmt.Errorf("JSON nesting limit exceeded")
	}
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	switch token {
	case json.Delim('{'):
		return scanObject(decoder, depth)
	case json.Delim('['):
		for decoder.More() {
			if err := scanValue(decoder, depth+1); err != nil {
				return err
			}
		}
		last, err := decoder.Token()
		if err != nil || last != json.Delim(']') {
			return fmt.Errorf("invalid JSON array")
		}
	case json.Delim('}'), json.Delim(']'):
		return fmt.Errorf("invalid JSON value")
	}
	return nil
}
