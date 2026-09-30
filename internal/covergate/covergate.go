// Package covergate checks a Go cover profile against per-package floors.
//
// `go test -coverprofile` reports one number for the whole module, which lets
// a well-tested package hide an untested one. The gate holds every package to
// its own floor, and fails on a package that has no floor at all, so new code
// cannot arrive without a decision about how well it is tested.
package covergate

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"sort"
	"strconv"
	"strings"
)

// Config is the content of coverage.json.
type Config struct {
	// Exclude lists import-path prefixes that the gate ignores: generated
	// code, and packages whose tests need containers.
	Exclude []string `json:"exclude"`
	// Floors maps an import-path prefix to the minimum statement coverage, in
	// percent, of every package under it. The longest matching prefix wins.
	Floors map[string]float64 `json:"floors"`
}

// ParseConfig reads a Config and rejects floors outside 0 to 100.
func ParseConfig(r io.Reader) (Config, error) {
	var cfg Config
	dec := json.NewDecoder(r)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&cfg); err != nil {
		return Config{}, fmt.Errorf("parse coverage config: %w", err)
	}
	for prefix, floor := range cfg.Floors {
		if floor < 0 || floor > 100 {
			return Config{}, fmt.Errorf("floor for %q is %v, want 0 to 100", prefix, floor)
		}
	}
	return cfg, nil
}

// Package is the measured coverage of one package.
type Package struct {
	ImportPath string
	Statements int
	Covered    int
}

// Percent is the statement coverage in percent. A package with no statements
// is fully covered: there is nothing left to test.
func (p Package) Percent() float64 {
	if p.Statements == 0 {
		return 100
	}
	return 100 * float64(p.Covered) / float64(p.Statements)
}

type block struct {
	statements int
	hit        bool
}

// ParseProfile reads a cover profile and totals it per package. A block that
// appears more than once (one entry per test binary) counts once, and is
// covered when any entry hit it.
func ParseProfile(r io.Reader) ([]Package, error) {
	blocks := map[string]map[string]block{}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	line := 0
	for sc.Scan() {
		line++
		text := strings.TrimSpace(sc.Text())
		if text == "" || strings.HasPrefix(text, "mode:") {
			continue
		}
		// file.go:12.34,15.2 3 1
		fields := strings.Fields(text)
		colon := strings.LastIndex(fields[0], ":")
		if len(fields) != 3 || colon < 0 {
			return nil, fmt.Errorf("cover profile line %d: malformed entry %q", line, text)
		}
		statements, err := strconv.Atoi(fields[1])
		if err != nil {
			return nil, fmt.Errorf("cover profile line %d: statement count: %w", line, err)
		}
		count, err := strconv.Atoi(fields[2])
		if err != nil {
			return nil, fmt.Errorf("cover profile line %d: hit count: %w", line, err)
		}
		pkg := path.Dir(fields[0][:colon])
		if blocks[pkg] == nil {
			blocks[pkg] = map[string]block{}
		}
		b := blocks[pkg][fields[0]]
		b.statements = statements
		b.hit = b.hit || count > 0
		blocks[pkg][fields[0]] = b
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("read cover profile: %w", err)
	}

	pkgs := make([]Package, 0, len(blocks))
	for importPath, bs := range blocks {
		p := Package{ImportPath: importPath}
		for _, b := range bs {
			p.Statements += b.statements
			if b.hit {
				p.Covered += b.statements
			}
		}
		pkgs = append(pkgs, p)
	}
	sort.Slice(pkgs, func(i, j int) bool { return pkgs[i].ImportPath < pkgs[j].ImportPath })
	return pkgs, nil
}

// Result is the verdict on one package.
type Result struct {
	Package
	Floor float64
	// HasFloor is false when no prefix in the config matches the package.
	HasFloor bool
}

// OK reports whether the package meets its floor.
func (r Result) OK() bool {
	// Compare in statements, not percent, so 100 means every statement and
	// rounding cannot let one through.
	return r.HasFloor && float64(r.Covered)*100 >= r.Floor*float64(r.Statements)
}

// ErrBelowFloor is returned by Check when at least one package fails.
var ErrBelowFloor = errors.New("coverage below floor")

// Check applies the config to the measured packages. It returns one Result per
// package that is not excluded, and ErrBelowFloor when any of them fails.
func Check(cfg Config, pkgs []Package) ([]Result, error) {
	results := make([]Result, 0, len(pkgs))
	failed := false
	for _, p := range pkgs {
		if hasPrefix(cfg.Exclude, p.ImportPath) {
			continue
		}
		r := Result{Package: p}
		r.Floor, r.HasFloor = floorFor(cfg.Floors, p.ImportPath)
		if !r.OK() {
			failed = true
		}
		results = append(results, r)
	}
	if failed {
		return results, ErrBelowFloor
	}
	return results, nil
}

// Report writes one line per result.
func Report(w io.Writer, results []Result) {
	for _, r := range results {
		switch {
		case !r.HasFloor:
			fmt.Fprintf(w, "FAIL  %-44s %6.1f%%  no floor: add one to coverage.json\n", r.ImportPath, r.Percent())
		case !r.OK():
			fmt.Fprintf(w, "FAIL  %-44s %6.1f%%  floor %.1f%% (%d of %d statements)\n",
				r.ImportPath, r.Percent(), r.Floor, r.Covered, r.Statements)
		default:
			fmt.Fprintf(w, "ok    %-44s %6.1f%%  floor %.1f%%\n", r.ImportPath, r.Percent(), r.Floor)
		}
	}
}

// matches reports whether importPath is prefix or lies under it. A prefix
// matches whole path elements only, so "a/b" does not match "a/bc".
func matches(prefix, importPath string) bool {
	prefix = strings.TrimSuffix(prefix, "/")
	return importPath == prefix || strings.HasPrefix(importPath, prefix+"/")
}

func hasPrefix(prefixes []string, importPath string) bool {
	for _, prefix := range prefixes {
		if matches(prefix, importPath) {
			return true
		}
	}
	return false
}

func floorFor(floors map[string]float64, importPath string) (float64, bool) {
	best, found := "", false
	for prefix := range floors {
		if matches(prefix, importPath) && (!found || len(prefix) > len(best)) {
			best, found = prefix, true
		}
	}
	return floors[best], found
}
