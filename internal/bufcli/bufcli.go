// Package bufcli runs buf, the compiler of the proto files. wirebook does not
// parse a proto file itself: buf knows every edition, and the repository
// already has the version it wants.
package bufcli

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"slices"
	"strings"
)

// Build runs `buf build` in dir and returns the image: the descriptor set
// with source info and with the imports marked. command is buf itself, or
// the words that run it, such as "bunx buf".
func Build(ctx context.Context, command []string, dir string) ([]byte, error) {
	if len(command) == 0 {
		return nil, errors.New("no command for buf")
	}
	// A slice of its own: the caller's command is not written to.
	args := slices.Concat(command[1:], []string{"build", "-o", "-#format=binpb"})
	cmd := exec.CommandContext(ctx, command[0], args...) //nolint:gosec // G204: the command is the --buf flag; running it is the point.
	cmd.Dir = dir
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return nil, fmt.Errorf("%s was not found: install buf, pass --buf with the words that run it (such as --buf \"bunx buf\"), or pass --image", command[0])
		}
		if message := strings.TrimSpace(stderr.String()); message != "" {
			return nil, fmt.Errorf("buf build failed:\n%s", message)
		}
		return nil, fmt.Errorf("buf build failed: %w", err)
	}
	return stdout.Bytes(), nil
}
