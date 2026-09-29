// Command wirebook builds and serves an API explorer from proto files.
package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/g0itb4/wirebook/internal/cli"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := cli.Run(ctx, os.Args[1:], os.Stdout, os.Stderr)
	stop()
	os.Exit(code)
}
