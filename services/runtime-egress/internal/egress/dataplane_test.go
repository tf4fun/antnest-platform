package egress

import "testing"

func TestConntrackOutputHasFlow(t *testing.T) {
	tests := []struct {
		name   string
		output string
		want   bool
	}{
		{
			name:   "zero entry summary",
			output: "conntrack v1.4.8 (conntrack-tools): 0 flow entries have been shown.\n",
		},
		{
			name: "tcp flow",
			output: "tcp 6 431999 ESTABLISHED src=100.96.0.2 dst=1.1.1.1 sport=49152 dport=443 " +
				"src=1.1.1.1 dst=192.0.2.10 sport=443 dport=49152 [ASSURED] mark=0 use=1\n",
			want: true,
		},
		{
			name:   "diagnostic mentioning only source",
			output: "conntrack: filter src=100.96.0.2 matched no entries\n",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := conntrackOutputHasFlow(test.output); got != test.want {
				t.Fatalf("conntrackOutputHasFlow() = %t, want %t", got, test.want)
			}
		})
	}
}
