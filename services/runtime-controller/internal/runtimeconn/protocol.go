package runtimeconn

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

const Version = "2.0"

const (
	CodeParseError     = -32700
	CodeInvalidRequest = -32600
	CodeMethodNotFound = -32601
	CodeInvalidParams  = -32602
	CodeInternalError  = -32603
)

type Error struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	return fmt.Sprintf("JSON-RPC error %d: %s", e.Code, e.Message)
}

type message struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      *string         `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *Error          `json:"error,omitempty"`
}

func decodeMessage(data []byte) (message, error) {
	data = bytes.TrimSpace(data)
	if len(data) == 0 || data[0] == '[' {
		return message{}, fmt.Errorf("JSON-RPC batch and empty messages are not supported")
	}
	var envelope message
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil {
		return message{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errorsIsEOF(err) {
		if err == nil {
			return message{}, fmt.Errorf("JSON-RPC message contains trailing data")
		}
		return message{}, err
	}
	if envelope.JSONRPC != Version {
		return message{}, fmt.Errorf("JSON-RPC version must be %q", Version)
	}
	request := strings.TrimSpace(envelope.Method) != ""
	response := envelope.Result != nil || envelope.Error != nil
	if request == response {
		return message{}, fmt.Errorf("JSON-RPC envelope must be exactly one request or response")
	}
	if request {
		if len(envelope.Params) != 0 && !isJSONObject(envelope.Params) {
			return message{}, fmt.Errorf("JSON-RPC params must be an object")
		}
		return envelope, nil
	}
	if envelope.ID == nil || strings.TrimSpace(*envelope.ID) == "" {
		return message{}, fmt.Errorf("JSON-RPC response id must be a non-empty string")
	}
	if envelope.Error != nil && envelope.Result != nil {
		return message{}, fmt.Errorf("JSON-RPC response cannot contain both result and error")
	}
	return envelope, nil
}

func errorsIsEOF(err error) bool {
	return err == io.EOF
}

func isJSONObject(value json.RawMessage) bool {
	trimmed := bytes.TrimSpace(value)
	return len(trimmed) >= 2 && trimmed[0] == '{' && trimmed[len(trimmed)-1] == '}'
}

func decodeJSONStrict(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errorsIsEOF(err) {
		if err == nil {
			return fmt.Errorf("JSON value contains trailing data")
		}
		return err
	}
	return nil
}

func decodeParams(raw json.RawMessage, target any) error {
	if len(bytes.TrimSpace(raw)) == 0 {
		raw = json.RawMessage("{}")
	}
	return decodeJSONStrict(raw, target)
}

func rpcError(code int, err error) *Error {
	if err == nil {
		return &Error{Code: code, Message: "runtime request failed"}
	}
	return &Error{Code: code, Message: boundedMessage(err)}
}

func rpcRequestError(code int, err error) *Error {
	return rpcError(code, err)
}

func marshalRequest(id *string, method string, params any) ([]byte, error) {
	raw, err := marshalObject(params)
	if err != nil {
		return nil, err
	}
	return json.Marshal(message{JSONRPC: Version, ID: id, Method: strings.TrimSpace(method), Params: raw})
}

func marshalResponse(id string, result any, rpcErr *Error) ([]byte, error) {
	envelope := message{JSONRPC: Version, ID: &id, Error: rpcErr}
	if rpcErr == nil {
		raw, err := json.Marshal(result)
		if err != nil {
			return nil, err
		}
		envelope.Result = raw
	}
	return json.Marshal(envelope)
}

func marshalObject(value any) (json.RawMessage, error) {
	if value == nil {
		return json.RawMessage("{}"), nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	if !isJSONObject(raw) {
		return nil, fmt.Errorf("JSON-RPC params must encode as an object")
	}
	return raw, nil
}
