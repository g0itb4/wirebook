// Command covergate fails when a package's unit test coverage is below its
// floor in coverage.json. `just cover-go` runs it after the offline test tier.
package main

import (
	"bytes"
	"errors"
	"flag"
	"fmt"
	"os"

	"github.com/g0itb4/wirebook/internal/covergate"
)

func main() {
	profilePath := flag.String("profile", "coverage/unit.coverprofile", "cover profile written by go test")
	configPath := flag.String("config", "coverage.json", "per-package floors")
	flag.Parse()

	if err := run(*profilePath, *configPath); err != nil {
		fmt.Fprintln(os.Stderr, "covergate:", err)
		os.Exit(1)
	}
}

func run(profilePath, configPath string) error {
	config, err := os.ReadFile(configPath)
	if err != nil {
		return err
	}
	cfg, err := covergate.ParseConfig(bytes.NewReader(config))
	if err != nil {
		return err
	}

	profile, err := os.ReadFile(profilePath)
	if err != nil {
		return err
	}
	pkgs, err := covergate.ParseProfile(bytes.NewReader(profile))
	if err != nil {
		return err
	}

	results, err := covergate.Check(cfg, pkgs)
	covergate.Report(os.Stdout, results)
	if errors.Is(err, covergate.ErrBelowFloor) {
		return errors.New("coverage is below a floor; add tests, do not lower the floor")
	}
	return err
}
