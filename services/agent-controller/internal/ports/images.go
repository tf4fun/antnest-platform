package ports

import "context"

type ResolvedImage struct {
	Reference string
	ImageRef  string
}

type ImageResolver interface {
	ResolveImage(context.Context, string) (ResolvedImage, error)
}
