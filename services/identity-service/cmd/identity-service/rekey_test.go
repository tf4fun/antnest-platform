package main

import (
	"io"
	"testing"
)

func TestRekeyRejectsArgumentsBeforeLoadingCredentials(t *testing.T) {
	err := runRekey(t.Context(), func(string) (string, bool) { t.Fatal("invalid command read environment"); return "", false }, []string{"--batch-size=0"}, io.Discard)
	if err == nil || serviceFailureClass(err) != "rekey_arguments" {
		t.Fatalf("invalid command result: %v", err)
	}
}
