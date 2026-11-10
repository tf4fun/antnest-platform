package telemetry

import (
	"errors"
	"fmt"
)

func CauseTypes(err error, limit int) []string {
	if err == nil || limit <= 0 {
		return nil
	}
	types := []string{}
	queue := []error{err}
	for len(queue) > 0 && len(types) < limit {
		current := queue[0]
		queue = queue[1:]
		types = append(types, fmt.Sprintf("%T", current))
		var children []error
		if joined, ok := current.(interface{ Unwrap() []error }); ok {
			children = joined.Unwrap()
		} else if single := errors.Unwrap(current); single != nil {
			children = []error{single}
		}
		remaining := limit - len(types) - len(queue)
		for _, child := range children {
			if child == nil || remaining <= 0 {
				continue
			}
			queue = append(queue, child)
			remaining--
		}
	}
	return types
}
