package web

import (
	"embed"
	"io/fs"
)

//go:embed static
var embedded embed.FS

func Dist() (fs.FS, error) {
	return fs.Sub(embedded, "static")
}
