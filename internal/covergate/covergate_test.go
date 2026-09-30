package covergate

import (
	"bytes"
	"errors"
	"strings"
	"testing"
	"testing/iotest"
)

const profile = `mode: atomic
example.com/app/internal/engine/a.go:1.1,2.2 3 1
example.com/app/internal/engine/a.go:3.1,4.2 1 0

example.com/app/internal/engine/dss/p.go:1.1,2.2 2 5
example.com/app/internal/service/s.go:1.1,2.2 4 0
example.com/app/internal/service/s.go:1.1,2.2 4 2
example.com/app/internal/service/s.go:5.1,6.2 6 0
example.com/app/internal/servicex/x.go:1.1,2.2 1 0
example.com/app/cmd/api/main.go:1.1,2.2 9 0
`

func TestParseProfile(t *testing.T) {
	t.Parallel()

	got, err := ParseProfile(strings.NewReader(profile))
	if err != nil {
		t.Fatal(err)
	}
	want := []Package{
		{ImportPath: "example.com/app/cmd/api", Statements: 9, Covered: 0},
		{ImportPath: "example.com/app/internal/engine", Statements: 4, Covered: 3},
		{ImportPath: "example.com/app/internal/engine/dss", Statements: 2, Covered: 2},
		// The duplicated block counts once and is covered.
		{ImportPath: "example.com/app/internal/service", Statements: 10, Covered: 4},
		{ImportPath: "example.com/app/internal/servicex", Statements: 1, Covered: 0},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d packages, want %d: %+v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("package %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestParseProfileErrors(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name, in, want string
	}{
		{name: "too few fields", in: "a/b.go:1.1,2.2 3", want: "malformed entry"},
		{name: "no colon", in: "a/b.go 3 1", want: "malformed entry"},
		{name: "bad statements", in: "a/b.go:1.1,2.2 x 1", want: "statement count"},
		{name: "bad count", in: "a/b.go:1.1,2.2 3 x", want: "hit count"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			_, err := ParseProfile(strings.NewReader(tt.in))
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Errorf("error = %v, want one containing %q", err, tt.want)
			}
		})
	}

	t.Run("read failure", func(t *testing.T) {
		t.Parallel()
		_, err := ParseProfile(iotest.ErrReader(errors.New("disk gone")))
		if err == nil || !strings.Contains(err.Error(), "disk gone") {
			t.Errorf("error = %v, want the reader's error", err)
		}
	})
}

func TestParseConfig(t *testing.T) {
	t.Parallel()

	cfg, err := ParseConfig(strings.NewReader(
		`{"exclude": ["a/gen"], "floors": {"a/engine": 100, "a/service": 80.5}}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Exclude) != 1 || cfg.Floors["a/engine"] != 100 || cfg.Floors["a/service"] != 80.5 {
		t.Errorf("config = %+v", cfg)
	}

	for name, in := range map[string]string{
		"not json":      `{`,
		"unknown field": `{"floor": {}}`,
		"above 100":     `{"floors": {"a": 101}}`,
		"negative":      `{"floors": {"a": -1}}`,
	} {
		if _, err := ParseConfig(strings.NewReader(in)); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
}

func TestPercent(t *testing.T) {
	t.Parallel()

	if got := (Package{Statements: 4, Covered: 3}).Percent(); got != 75 {
		t.Errorf("Percent = %v, want 75", got)
	}
	if got := (Package{}).Percent(); got != 100 {
		t.Errorf("Percent of an empty package = %v, want 100", got)
	}
}

func TestCheck(t *testing.T) {
	t.Parallel()

	pkgs, err := ParseProfile(strings.NewReader(profile))
	if err != nil {
		t.Fatal(err)
	}
	cfg := Config{
		Exclude: []string{"example.com/app/cmd/"},
		Floors: map[string]float64{
			"example.com/app/internal":            10,
			"example.com/app/internal/engine":     75,
			"example.com/app/internal/engine/dss": 100,
			"example.com/app/internal/service":    40,
		},
	}

	t.Run("passes at the floor", func(t *testing.T) {
		t.Parallel()
		results, err := Check(cfg, pkgs[:4])
		if err != nil {
			t.Fatalf("Check: %v", err)
		}
		// cmd/api is excluded, so three results remain.
		if len(results) != 3 {
			t.Fatalf("got %d results, want 3: %+v", len(results), results)
		}
		wantFloors := []float64{75, 100, 40}
		for i, r := range results {
			if r.Floor != wantFloors[i] || !r.OK() {
				t.Errorf("%s: floor %v ok %v, want floor %v ok", r.ImportPath, r.Floor, r.OK(), wantFloors[i])
			}
		}
	})

	t.Run("a prefix matches whole path elements", func(t *testing.T) {
		t.Parallel()
		// servicex is not under service: it takes the "internal" floor of 10
		// and fails it at 0%.
		results, err := Check(cfg, pkgs)
		if !errors.Is(err, ErrBelowFloor) {
			t.Fatalf("error = %v, want ErrBelowFloor", err)
		}
		last := results[len(results)-1]
		if last.ImportPath != "example.com/app/internal/servicex" || last.Floor != 10 || last.OK() {
			t.Errorf("servicex = %+v", last)
		}
	})

	t.Run("one statement short of 100 fails", func(t *testing.T) {
		t.Parallel()
		strict := Config{Floors: map[string]float64{"example.com/app/internal/engine": 100}}
		big := []Package{{ImportPath: "example.com/app/internal/engine", Statements: 100000, Covered: 99999}}
		if _, err := Check(strict, big); !errors.Is(err, ErrBelowFloor) {
			t.Errorf("error = %v, want ErrBelowFloor", err)
		}
	})

	t.Run("a package with no floor fails", func(t *testing.T) {
		t.Parallel()
		results, err := Check(Config{}, []Package{{ImportPath: "x/new", Statements: 1, Covered: 1}})
		if !errors.Is(err, ErrBelowFloor) || results[0].HasFloor {
			t.Errorf("results = %+v, error = %v", results, err)
		}
	})
}

func TestReport(t *testing.T) {
	t.Parallel()

	var buf bytes.Buffer
	Report(&buf, []Result{
		{Package: Package{ImportPath: "a/ok", Statements: 2, Covered: 2}, Floor: 100, HasFloor: true},
		{Package: Package{ImportPath: "a/low", Statements: 4, Covered: 1}, Floor: 50, HasFloor: true},
		{Package: Package{ImportPath: "a/new", Statements: 1, Covered: 1}},
	})
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 3 {
		t.Fatalf("got %d lines: %q", len(lines), buf.String())
	}
	for i, want := range []string{"ok    a/ok", "floor 50.0% (1 of 4 statements)", "no floor"} {
		if !strings.Contains(lines[i], want) {
			t.Errorf("line %d = %q, want it to contain %q", i, lines[i], want)
		}
	}
}
