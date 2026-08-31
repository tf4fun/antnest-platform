package identityid

import "testing"

func TestNewProducesOpaqueDistinctIDs(t *testing.T) {
	first, err := New()
	if err != nil {
		t.Fatal(err)
	}
	second, err := New()
	if err != nil {
		t.Fatal(err)
	}
	if first == second || len(first) < 20 || first[:3] != "id_" {
		t.Fatalf("ids = %q, %q", first, second)
	}
}
