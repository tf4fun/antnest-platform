package docker

import _ "embed"

//go:embed antnest-runtime-seccomp.json
var runtimeSeccompProfile string

func runtimeSeccompOption() string {
	return "seccomp=" + runtimeSeccompProfile
}
