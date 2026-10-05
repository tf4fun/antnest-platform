package secretencryption

import (
	"errors"
	"flag"
	"io"
)

const DefaultBatchSize = 100
const MaxBatchSize = 1000

var ErrBatchSize = errors.New("rekey batch size must be between 1 and 1000")

type Progress struct {
	Table     string `json:"table"`
	ActiveKID string `json:"active_kid"`
	Updated   int64  `json:"updated"`
	Remaining int64  `json:"remaining"`
}

func ParseRekeyArgs(args []string) (int, error) {
	flags := flag.NewFlagSet("rekey", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	batchSize := flags.Int("batch-size", DefaultBatchSize, "rows per transaction (1–1000)")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return 0, errors.New("usage: rekey [--batch-size N]")
	}
	if *batchSize < 1 || *batchSize > MaxBatchSize {
		return 0, ErrBatchSize
	}
	return *batchSize, nil
}
