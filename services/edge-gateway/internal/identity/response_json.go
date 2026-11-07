package identity

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
)

var identityResponseRawMessageType = reflect.TypeFor[json.RawMessage]()

func decodeResponseObject(raw []byte, target any) error {
	var document map[string]json.RawMessage
	if err := serviceauth.DecodeObject(raw, &document); err != nil {
		return err
	}
	projected, err := projectIdentityResponse(raw, reflect.TypeOf(target))
	if err != nil {
		return err
	}
	normalized, err := json.Marshal(projected)
	if err != nil {
		return err
	}
	return json.Unmarshal(normalized, target)
}

func projectIdentityResponse(raw json.RawMessage, kind reflect.Type) (any, error) {
	for kind.Kind() == reflect.Pointer {
		kind = kind.Elem()
	}
	trimmed := bytes.TrimSpace(raw)
	if kind == identityResponseRawMessageType || kind.Kind() == reflect.Map ||
		kind.Kind() == reflect.Interface || len(trimmed) == 0 ||
		(trimmed[0] != '{' && trimmed[0] != '[') {
		return raw, nil
	}
	switch kind.Kind() {
	case reflect.Struct:
		known := make(map[string]reflect.Type)
		collectIdentityResponseFields(kind, known)
		if len(known) == 0 {
			return raw, nil
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &fields); err != nil {
			return nil, err
		}
		projected := make(map[string]json.RawMessage, len(fields))
		for name, value := range fields {
			field, exists := known[name]
			if !exists {
				continue
			}
			entry, err := projectIdentityResponse(value, field)
			if err != nil {
				return nil, err
			}
			encoded, err := json.Marshal(entry)
			if err != nil {
				return nil, err
			}
			projected[name] = encoded
		}
		return projected, nil
	case reflect.Slice, reflect.Array:
		if kind.Elem().Kind() == reflect.Uint8 {
			return raw, nil
		}
		var elements []json.RawMessage
		if err := json.Unmarshal(raw, &elements); err != nil {
			return nil, err
		}
		projected := make([]json.RawMessage, len(elements))
		for index, element := range elements {
			entry, err := projectIdentityResponse(element, kind.Elem())
			if err != nil {
				return nil, err
			}
			encoded, err := json.Marshal(entry)
			if err != nil {
				return nil, err
			}
			projected[index] = encoded
		}
		return projected, nil
	}
	return raw, nil
}

func collectIdentityResponseFields(kind reflect.Type, fields map[string]reflect.Type) {
	for index := 0; index < kind.NumField(); index++ {
		field := kind.Field(index)
		if field.Anonymous {
			embedded := field.Type
			for embedded.Kind() == reflect.Pointer {
				embedded = embedded.Elem()
			}
			if embedded.Kind() == reflect.Struct {
				collectIdentityResponseFields(embedded, fields)
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
