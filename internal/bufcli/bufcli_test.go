package bufcli

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// script writes a shell script that stands in for buf.
func script(t *testing.T, body string) []string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "buf.sh")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	return []string{"sh", path}
}

func TestBuildReturnsWhatBufWrites(t *testing.T) {
	dir := t.TempDir()
	// The script says where it ran and what it was asked.
	command := script(t, `printf '%s|%s' "$(basename "$PWD")" "$*"`)
	got, err := Build(context.Background(), command, dir)
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Base(dir) + "|build -o -#format=binpb"; string(got) != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestBuildDoesNotGrowTheCallersCommand(t *testing.T) {
	command := make([]string, 2, 10)
	copy(command, script(t, "true"))
	if _, err := Build(context.Background(), command, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if extra := command[:3][2]; extra != "" {
		t.Errorf("Build wrote %q into the caller's slice", extra)
	}
}

func TestBuildReportsFailures(t *testing.T) {
	cases := []struct {
		name    string
		command []string
		want    string
	}{
		{"no command", nil, "no command for buf"},
		{"not installed", []string{"wirebook-no-such-buf"}, `wirebook-no-such-buf was not found: install buf`},
		{"buf says why", script(t, `echo "a.proto:3:1: syntax error" >&2; exit 100`), "buf build failed:\na.proto:3:1: syntax error"},
		{"buf says nothing", script(t, "exit 3"), "buf build failed: exit status 3"},
	}
	for _, c := range cases {
		_, err := Build(context.Background(), c.command, t.TempDir())
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: err = %v, want %q", c.name, err, c.want)
		}
	}
}
