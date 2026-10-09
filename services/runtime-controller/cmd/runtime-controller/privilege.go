package main

import (
	"fmt"
	"log/slog"
	"strconv"
	"strings"
)

func logStartupPrivileges(logger *slog.Logger, uid, gid int, platform string, readFile func(string) ([]byte, error)) error {
	capabilities := "unsupported"
	if platform == "linux" {
		status, err := readFile("/proc/self/status")
		if err != nil {
			return fmt.Errorf("read process privileges: %w", err)
		}
		var effective string
		for _, line := range strings.Split(string(status), "\n") {
			if value, ok := strings.CutPrefix(line, "CapEff:"); ok {
				effective = strings.TrimSpace(value)
				break
			}
		}
		mask, err := strconv.ParseUint(effective, 16, 64)
		if err != nil {
			return fmt.Errorf("invalid process effective capabilities: %w", err)
		}
		capabilities = fmt.Sprintf("%016x", mask)
	}
	logger.Info("Runtime Controller process privileges", "uid", uid, "gid", gid, "effective_capabilities", capabilities)
	return nil
}
