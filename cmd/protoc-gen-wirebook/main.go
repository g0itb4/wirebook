// Command protoc-gen-wirebook is wirebook as a plugin of buf and protoc. It
// writes the explorer as one HTML file.
//
//	# buf.gen.yaml
//	plugins:
//	  - local: ["go", "tool", "protoc-gen-wirebook"]
//	    out: docs/explorer
//	    strategy: all
package main

import (
	"fmt"
	"os"

	"github.com/g0itb4/wirebook/internal/plugin"
)

func main() {
	if err := plugin.Run(os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "protoc-gen-wirebook:", err)
		os.Exit(1)
	}
}
