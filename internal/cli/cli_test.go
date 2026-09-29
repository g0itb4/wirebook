package cli

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const fixture = "../../testdata/fixture.binpb"

// run executes a command line that ends on its own.
func run(t *testing.T, args ...string) (code int, stdout, stderr string) {
	t.Helper()
	var out, err bytes.Buffer
	code = Run(context.Background(), args, &out, &err)
	return code, out.String(), err.String()
}

// fakeBuf is a script that stands in for buf: it prints the fixture image.
func fakeBuf(t *testing.T) string {
	t.Helper()
	image, err := filepath.Abs(fixture)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "buf.sh")
	if err := os.WriteFile(path, []byte("#!/bin/sh\ncat '"+image+"'\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	return "sh " + path
}

func TestUsage(t *testing.T) {
	if code, _, stderr := run(t); code != 2 || !strings.Contains(stderr, "Usage:") {
		t.Errorf("no arguments: %d %q", code, stderr)
	}
	if code, _, stderr := run(t, "frobnicate"); code != 2 || !strings.Contains(stderr, `unknown command "frobnicate"`) {
		t.Errorf("unknown command: %d %q", code, stderr)
	}
	for _, arg := range []string{"help", "-h", "--help"} {
		if code, stdout, _ := run(t, arg); code != 0 || !strings.Contains(stdout, "wirebook serve [flags]") {
			t.Errorf("%s: %d %q", arg, code, stdout)
		}
	}
	for _, arg := range []string{"version", "-v", "--version"} {
		if code, stdout, _ := run(t, arg); code != 0 || stdout != "wirebook dev\n" {
			t.Errorf("%s: %d %q", arg, code, stdout)
		}
	}
	// A command's own help is not a failure; a flag it does not have is.
	if code, _, stderr := run(t, "build", "-h"); code != 0 || !strings.Contains(stderr, "-single-file") {
		t.Errorf("build -h: %d %q", code, stderr)
	}
	if code, _, stderr := run(t, "build", "--nope"); code != 2 || !strings.Contains(stderr, "flag provided but not defined") {
		t.Errorf("build --nope: %d %q", code, stderr)
	}
	if code, _, stderr := run(t, "build", "extra"); code != 2 || !strings.Contains(stderr, `unexpected argument "extra"`) {
		t.Errorf("build extra: %d %q", code, stderr)
	}
}

func TestBuildWritesADirectory(t *testing.T) {
	out := filepath.Join(t.TempDir(), "site")
	code, stdout, stderr := run(t, "build", "--image", fixture, "--out", out)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, stderr)
	}
	if want := "wrote " + out + ": 4 proto files documented\n"; stdout != want {
		t.Errorf("stdout = %q, want %q", stdout, want)
	}
	for _, name := range []string{"index.html", "app.js", "app.css", "core.wasm", "schema.binpb", "config.json"} {
		if info, err := os.Stat(filepath.Join(out, name)); err != nil || info.Size() == 0 {
			t.Errorf("%s: %v", name, err)
		}
	}
	config, _ := os.ReadFile(filepath.Join(out, "config.json"))
	if !strings.Contains(string(config), `"liveReload":false`) || !strings.Contains(string(config), `"fixture/v1/editions.proto"`) {
		t.Errorf("config.json = %s", config)
	}
}

func TestBuildRunsBufAndFindsTheConfig(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "wirebook.json"), []byte(`{"title": "From the module"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	single := filepath.Join(t.TempDir(), "nested", "explorer.html")
	code, stdout, stderr := run(t, "build", "--dir", dir, "--buf", fakeBuf(t), "--single-file", single)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, stderr)
	}
	if !strings.Contains(stdout, "wrote "+single) {
		t.Errorf("stdout = %q", stdout)
	}
	page, err := os.ReadFile(single)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(page), "<title>From the module</title>") || !strings.Contains(string(page), `id="wirebook-core"`) {
		t.Error("the single file lacks the config's title or the core")
	}

	// --config wins over the one in the directory.
	other := filepath.Join(t.TempDir(), "other.json")
	if err := os.WriteFile(other, []byte(`{"title": "From the flag"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if code, _, stderr := run(t, "build", "--dir", dir, "--buf", fakeBuf(t), "--config", other, "--single-file", single); code != 0 {
		t.Fatalf("exit %d: %s", code, stderr)
	}
	page, _ = os.ReadFile(single)
	if !strings.Contains(string(page), "<title>From the flag</title>") {
		t.Error("--config was not used")
	}
}

func TestBuildFailures(t *testing.T) {
	dir := t.TempDir()
	notAnImage := filepath.Join(dir, "junk.binpb")
	if err := os.WriteFile(notAnImage, []byte{0xff, 0xff}, 0o600); err != nil {
		t.Fatal(err)
	}
	badConfig := filepath.Join(dir, "bad.json")
	if err := os.WriteFile(badConfig, []byte(`{"token": "s3cr3t"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	aFile := filepath.Join(dir, "file")
	if err := os.WriteFile(aFile, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name string
		args []string
		want string
	}{
		{"no such image", []string{"--image", filepath.Join(dir, "missing")}, "no such file"},
		{"not an image", []string{"--image", notAnImage}, "the descriptor set is not valid"},
		{"a config with a secret", []string{"--image", fixture, "--config", badConfig}, `unknown field "token"`},
		{"buf is not installed", []string{"--buf", "wirebook-no-such-buf"}, "wirebook-no-such-buf was not found"},
		{"the directory cannot be made", []string{"--image", fixture, "--out", filepath.Join(aFile, "site")}, "not a directory"},
		{"the file's directory cannot be made", []string{"--image", fixture, "--single-file", filepath.Join(aFile, "x", "a.html")}, "not a directory"},
		{"the file cannot be written", []string{"--image", fixture, "--single-file", dir}, "file exists"},
	}
	for _, c := range cases {
		code, _, stderr := run(t, append([]string{"build"}, c.args...)...)
		if code != 1 || !strings.HasPrefix(stderr, "wirebook: ") || !strings.Contains(stderr, c.want) {
			t.Errorf("%s: exit %d, stderr %q, want %q", c.name, code, stderr, c.want)
		}
	}
}

func TestServeRefusesBadFlags(t *testing.T) {
	cases := map[string][]string{
		"--target must be an http or https URL":                                                    {"--image", fixture, "--target", "localhost:8080"},
		"--target must be an http or https URL, such as http://localhost:8080; got \"ftp://x\"":    {"--image", fixture, "--target", "ftp://x"},
		"--target must be an http or https URL, such as http://localhost:8080; got \"http://\"":    {"--image", fixture, "--target", "http://"},
		"--target must be an http or https URL, such as http://localhost:8080; got \"http://a b\"": {"--image", fixture, "--target", "http://a b"},
		"--interval must be more than zero":                                                        {"--image", fixture, "--interval", "0s"},
		"no such file":                                                                             {"--image", "missing.binpb"},
		"flag provided but not defined":                                                            {"--nope"},
	}
	for want, args := range cases {
		code, _, stderr := run(t, append([]string{"serve"}, args...)...)
		if code == 0 || !strings.Contains(stderr, want) {
			t.Errorf("%v: exit %d, stderr %q, want %q", args, code, stderr, want)
		}
	}
	// The address is taken.
	taken := httptest.NewServer(http.NotFoundHandler())
	defer taken.Close()
	code, _, stderr := run(t, "serve", "--image", fixture, "--addr", strings.TrimPrefix(taken.URL, "http://"))
	if code != 1 || !strings.Contains(stderr, "address already in use") {
		t.Errorf("a taken address: exit %d, stderr %q", code, stderr)
	}
}

// lines collects what a running command prints.
type lines struct {
	mu   sync.Mutex
	buf  bytes.Buffer
	read *io.PipeReader
	w    *io.PipeWriter
}

func (l *lines) Write(p []byte) (int, error) {
	l.mu.Lock()
	l.buf.Write(p)
	l.mu.Unlock()
	return l.w.Write(p)
}

func (l *lines) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.String()
}

// serving starts `wirebook serve` and returns its address and a stop.
func serving(t *testing.T, args ...string) (base string, stderr *lockedBuffer, stop func() int) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	read, write := io.Pipe()
	stdout := &lines{read: read, w: write}
	stderr = &lockedBuffer{}
	code := make(chan int, 1)
	go func() {
		code <- Run(ctx, append([]string{"serve", "--addr", "127.0.0.1:0"}, args...), stdout, stderr)
		_ = write.Close()
	}()
	scanner := bufio.NewScanner(read)
	found := make(chan string, 1)
	go func() {
		for scanner.Scan() {
			if address, ok := strings.CutPrefix(scanner.Text(), "wirebook: http://"); ok {
				found <- "http://" + address
			}
		}
		close(found)
	}()
	stopped := false
	stop = func() int {
		if stopped {
			return -1
		}
		stopped = true
		cancel()
		select {
		case c := <-code:
			return c
		case <-time.After(10 * time.Second):
			t.Fatal("serve did not stop when its context was done")
			return -1
		}
	}
	t.Cleanup(func() { stop() })
	select {
	case base, ok := <-found:
		if !ok {
			t.Fatalf("serve exited before it listened: %s", stderr)
		}
		return base, stderr, stop
	case <-time.After(10 * time.Second):
		t.Fatalf("serve did not say where it listens: %s", stderr)
		return "", nil, nil
	}
}

type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.String()
}

func fetch(t *testing.T, url string) (int, string) {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	// What a browser adds to a request of the site's own page.
	request.Header.Set("Sec-Fetch-Site", "same-origin")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	return response.StatusCode, string(body)
}

func TestServeServesTheSiteAndProxies(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "api saw "+r.URL.Path)
	}))
	defer api.Close()

	base, _, stop := serving(t, "--image", fixture, "--target", api.URL+"/")
	if code, body := fetch(t, base+"/"); code != http.StatusOK || !strings.Contains(body, "<title>API explorer</title>") {
		t.Errorf("GET /: %d", code)
	}
	_, config := fetch(t, base+"/config.json")
	apiHost := strings.TrimPrefix(api.URL, "http://")
	for _, want := range []string{
		`"liveReload":true`,
		// The proxy is the first environment, and knows where the API is.
		`"environments":[{"name":"Proxy to ` + apiHost + `","baseUrl":"/proxy","directUrl":"` + api.URL + `"}]`,
	} {
		if !strings.Contains(config, want) {
			t.Errorf("config.json lacks %s:\n%s", want, config)
		}
	}
	if code, body := fetch(t, base+"/proxy/v1/widgets/w1"); code != http.StatusOK || body != "api saw /v1/widgets/w1" {
		t.Errorf("proxy: %d %q", code, body)
	}
	if code := stop(); code != 0 {
		t.Errorf("exit %d after a stop, want 0", code)
	}
}

func TestServeRebuildsWhenAnInputChanges(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "wirebook.json")
	if err := os.WriteFile(configPath, []byte(`{"title": "One"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	// A proto to watch, and directories the watch stays out of.
	for _, path := range []string{"proto/a.proto", "node_modules/pkg/b.proto", ".git/c.proto"} {
		full := filepath.Join(dir, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("syntax"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	base, stderr, _ := serving(t, "--dir", dir, "--buf", fakeBuf(t), "--interval", "5ms")
	title := func() string {
		_, config := fetch(t, base+"/config.json")
		return config
	}
	if !strings.Contains(title(), `"title":"One"`) {
		t.Fatalf("config = %s", title())
	}
	// No target: no proxy environment, and no proxy.
	if strings.Contains(title(), "/proxy") {
		t.Errorf("a proxy environment without a target: %s", title())
	}
	if code, _ := fetch(t, base+"/proxy/x"); code != http.StatusNotFound {
		t.Errorf("proxy without a target: %d, want 404", code)
	}

	waitFor := func(want string) {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for !strings.Contains(title(), want) {
			if time.Now().After(deadline) {
				t.Fatalf("config never had %s: %s\n%s", want, title(), stderr)
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	if err := os.WriteFile(configPath, []byte(`{"title": "Two, longer"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	waitFor(`"title":"Two, longer"`)

	// The new site is served a moment before the build is logged: wait for
	// the log too, or that line would be counted as a later build.
	logged := time.Now().Add(10 * time.Second)
	for !strings.Contains(stderr.String(), "rebuilt") {
		if time.Now().After(logged) {
			t.Fatalf("the rebuild was never logged:\n%s", stderr)
		}
		time.Sleep(time.Millisecond)
	}

	// A change in a skipped directory builds nothing.
	builds := strings.Count(stderr.String(), "rebuilt")
	if err := os.WriteFile(filepath.Join(dir, "node_modules/pkg/b.proto"), []byte("changed, and longer"), 0o600); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	if got := strings.Count(stderr.String(), "rebuilt"); got != builds {
		t.Errorf("a change under node_modules caused %d builds", got-builds)
	}

	// A change of a proto does. The config changes with it, to show the build.
	if err := os.WriteFile(filepath.Join(dir, "proto/a.proto"), []byte("syntax, edited"), 0o600); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for strings.Count(stderr.String(), "rebuilt") == builds {
		if time.Now().After(deadline) {
			t.Fatalf("a changed proto was not built:\n%s", stderr)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestSignature(t *testing.T) {
	dir := t.TempDir()
	image := filepath.Join(dir, "image.binpb")
	if err := os.WriteFile(image, []byte("one"), 0o600); err != nil {
		t.Fatal(err)
	}
	withImage := source{image: image, dir: dir}
	before := withImage.signature()
	if before != withImage.signature() {
		t.Error("the signature changes on its own")
	}
	if err := os.WriteFile(image, []byte("two, longer"), 0o600); err != nil {
		t.Fatal(err)
	}
	if withImage.signature() == before {
		t.Error("the signature did not follow the image")
	}

	// A directory that cannot be walked has a signature all the same.
	missing := source{dir: filepath.Join(dir, "no-such-dir")}
	if missing.signature() == "" {
		t.Error("no signature for a missing directory")
	}
}

func TestLoopbackAddr(t *testing.T) {
	for addr, want := range map[string]bool{
		"127.0.0.1:9000": true,
		"localhost:9000": true,
		"[::1]:9000":     true,
		":9000":          false,
		"0.0.0.0:9000":   false,
		"192.168.1.5:80": false,
		"no-port":        false,
	} {
		if got := loopbackAddr(addr); got != want {
			t.Errorf("loopbackAddr(%q) = %v, want %v", addr, got, want)
		}
	}
}

func TestServeRefusesATargetThatCarriesMoreThanAnAddress(t *testing.T) {
	// The target is written into the site's config: nothing secret may ride on it.
	for _, target := range []string{"http://user:s3cr3t@localhost:8080", "http://localhost:8080/?key=s3cr3t", "http://localhost:8080/#x"} {
		code, _, stderr := run(t, "serve", "--image", fixture, "--target", target)
		if code != 1 || !strings.Contains(stderr, "--target must not carry a user name, a password, a query or a fragment") {
			t.Errorf("%s: exit %d, stderr %q", target, code, stderr)
		}
		if strings.Contains(stderr, "s3cr3t") {
			t.Errorf("%s: the refusal repeats the secret: %q", target, stderr)
		}
	}
}

// started runs `wirebook serve` until its output has `ready`, stops it, and
// returns what it wrote to stderr.
func started(t *testing.T, ready string, args ...string) string {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var out, errs lockedBuffer
	done := make(chan int, 1)
	go func() { done <- Run(ctx, append([]string{"serve", "--image", fixture}, args...), &out, &errs) }()
	deadline := time.Now().Add(10 * time.Second)
	for !strings.Contains(out.String(), ready) {
		if time.Now().After(deadline) {
			t.Fatalf("serve did not start: %s", errs.String())
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	<-done
	return errs.String()
}

func TestServeWarnsWhenItListensBeyondThisMachine(t *testing.T) {
	api := httptest.NewServer(http.NotFoundHandler())
	defer api.Close()

	if stderr := started(t, "/proxy forwards to", "--addr", "127.0.0.1:0", "--target", api.URL); strings.Contains(stderr, "warning") {
		t.Errorf("a warning for a loopback address: %s", stderr)
	}
	stderr := started(t, "/proxy forwards to", "--addr", "0.0.0.0:0", "--target", api.URL)
	want := "warning: 0.0.0.0:0 is not a loopback address. Whoever can reach it can read the site and use the proxy to " + api.URL + ".\n"
	if !strings.Contains(stderr, want) {
		t.Errorf("stderr = %q, want %q in it", stderr, want)
	}
	stderr = started(t, "wirebook: http://", "--addr", ":0")
	if want := "warning: :0 is not a loopback address. Whoever can reach it can read the site.\n"; !strings.Contains(stderr, want) {
		t.Errorf("stderr = %q, want %q in it", stderr, want)
	}
}

func TestHosts(t *testing.T) {
	own, err := os.Hostname()
	if err != nil {
		t.Skip("this machine has no host name")
	}
	if got := hosts(""); len(got) != 1 || got[0] != own {
		t.Errorf("hosts(\"\") = %v, want this machine's name", got)
	}
	got := hosts("devbox, dev.internal ,,")
	if want := []string{"devbox", "dev.internal", own}; strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("hosts = %v, want %v", got, want)
	}
}

func TestServeBeyondLoopbackRefusesANameItWasNotGiven(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	read, write := io.Pipe()
	var errs lockedBuffer
	go func() {
		Run(ctx, []string{"serve", "--image", fixture, "--addr", "0.0.0.0:0", "--allow-host", "devbox"}, write, &errs)
		_ = write.Close()
	}()
	scanner := bufio.NewScanner(read)
	base := ""
	for scanner.Scan() {
		if address, ok := strings.CutPrefix(scanner.Text(), "wirebook: http://"); ok {
			_, port, _ := strings.Cut(address, "]:")
			base = "http://127.0.0.1:" + port
			break
		}
	}
	go func() { _, _ = io.Copy(io.Discard, read) }()
	if base == "" {
		t.Fatalf("serve did not start: %s", errs.String())
	}
	for host, want := range map[string]int{"devbox": http.StatusOK, "rebound.evil.example": http.StatusForbidden} {
		request, _ := http.NewRequest(http.MethodGet, base+"/", nil)
		request.Host = host
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != want {
			t.Errorf("Host %s: %d, want %d", host, response.StatusCode, want)
		}
	}
}
