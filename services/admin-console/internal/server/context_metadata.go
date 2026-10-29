package server

import (
	"encoding/json"
	"errors"
	"unicode"
)

func validateModelContextMetadata(raw json.RawMessage) error {
	var model struct {
		Tokenizer                json.RawMessage `json:"tokenizer"`
		CompactionModelProfileID json.RawMessage `json:"compaction_model_profile_id"`
	}
	if err := json.Unmarshal(raw, &model); err != nil {
		return err
	}
	if len(model.Tokenizer) > 0 {
		var tokenizer string
		if err := json.Unmarshal(model.Tokenizer, &tokenizer); err != nil {
			return errors.New("tokenizer must be a string")
		}
		if tokenizer != "o200k" && tokenizer != "cl100k" && tokenizer != "none" {
			return errors.New("invalid tokenizer")
		}
	}
	if len(model.CompactionModelProfileID) > 0 {
		var reference string
		if err := json.Unmarshal(model.CompactionModelProfileID, &reference); err != nil {
			return errors.New("compaction_model_profile_id must be a string")
		}
		if reference == "" || len(reference) > 200 {
			return errors.New("invalid compaction_model_profile_id")
		}
		for _, symbol := range reference {
			if unicode.IsSpace(symbol) {
				return errors.New("compaction_model_profile_id must not contain whitespace")
			}
		}
	}
	return nil
}
