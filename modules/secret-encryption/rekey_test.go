package secretencryption

import "testing"

func TestRekeyArgumentsAreBounded(t *testing.T) {
	for _, args := range [][]string{{}, {"--batch-size", "1"}, {"--batch-size=1000"}} {
		if size, err := ParseRekeyArgs(args); err != nil || size < 1 || size > MaxBatchSize {
			t.Fatalf("valid arguments: size=%d err=%v", size, err)
		}
	}
	for _, args := range [][]string{{"--batch-size=0"}, {"--batch-size=1001"}, {"--batch-size=no"}, {"--key=private"}, {"unexpected"}} {
		if _, err := ParseRekeyArgs(args); err == nil {
			t.Fatalf("accepted invalid arguments: %v", args)
		}
	}
}
