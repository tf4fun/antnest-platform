package credentials

import "errors"

const (
	argonMemory      = 64 * 1024
	argonIterations  = 3
	argonParallelism = 2
	argonSaltBytes   = 16
	argonKeyBytes    = 32
	minimumPassword  = 12
	maximumPassword  = 1024
)

var ErrInvalidPasswordEncoding = errors.New("invalid password encoding")
