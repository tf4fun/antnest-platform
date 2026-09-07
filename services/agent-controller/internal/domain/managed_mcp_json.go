package domain

import (
	"bytes"
	"encoding/json"
	"errors"
	"strconv"
	"unicode/utf8"
)

func (server *MCPServer) UnmarshalJSON(data []byte) error {
	// encoding/json replaces malformed Unicode. Process configuration must be
	// preserved exactly instead; validate encoding before decoding the structure.
	if !validMCPJSONUnicode(data) {
		return errors.New("invalid Unicode in MCP configuration")
	}
	type plain MCPServer
	var decoded plain
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&decoded); err != nil {
		return err
	}
	*server = MCPServer(decoded)
	return nil
}

func validMCPJSONUnicode(data []byte) bool {
	if !utf8.Valid(data) || !json.Valid(data) {
		return false
	}
	for index := 0; index < len(data); index++ {
		if data[index] != '\\' {
			continue
		}
		index++
		if data[index] != 'u' {
			continue
		}
		unit, ok := unicodeUnit(data[index+1:])
		if !ok {
			return false
		}
		index += 4
		if unit >= 0xdc00 && unit <= 0xdfff {
			return false
		}
		if unit < 0xd800 || unit > 0xdbff {
			continue
		}
		if index+6 >= len(data) || data[index+1] != '\\' || data[index+2] != 'u' {
			return false
		}
		low, ok := unicodeUnit(data[index+3:])
		if !ok || low < 0xdc00 || low > 0xdfff {
			return false
		}
		index += 6
	}
	return true
}

func unicodeUnit(data []byte) (uint64, bool) {
	if len(data) < 4 {
		return 0, false
	}
	value, err := strconv.ParseUint(string(data[:4]), 16, 16)
	return value, err == nil
}
