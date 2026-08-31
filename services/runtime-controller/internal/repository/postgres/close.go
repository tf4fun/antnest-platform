package postgres

import (
	"database/sql"
	"errors"
	"fmt"
)

func joinCloseError(resultErr *error, resource string, closeFunc func() error) {
	err := closeFunc()
	if err == nil || errors.Is(err, sql.ErrConnDone) {
		return
	}
	*resultErr = errors.Join(*resultErr, fmt.Errorf("close %s: %w", resource, err))
}
