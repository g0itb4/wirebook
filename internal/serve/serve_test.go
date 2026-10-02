package serve

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// site is a Build that can be told what to return.
type site struct {
	mu     sync.Mutex
	files  map[string][]byte
	err    error
	builds int
}

func (s *site) build(context.Context) (map[string][]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.builds++
	return s.files, s.err
}

func (s *site) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.builds
}

func (s *site) set(files map[string][]byte, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.files, s.err = files, err
}

func pages(index string) map[string][]byte {
	return map[string][]byte{
		"index.html":    []byte(index),
		"app.js":        []byte("js"),
		"app.css":       []byte("css"),
		"core.wasm":     []byte("wasm"),
		"fonts/a.woff2": []byte("font"),
		"fonts/OFL.txt": []byte("licence"),
		"schema.binpb":  []byte("schema"),
		"config.json":   []byte("{}"),
	}
}

func start(t *testing.T, opts Options) (*Server, *httptest.Server, *logBuffer) {
	t.Helper()
	logs := &logBuffer{}
	opts.Log = slog.New(slog.NewTextHandler(logs, nil))
	if opts.Build == nil {
		opts.Build = (&site{files: pages("page")}).build
	}
	server, err := New(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	listening := httptest.NewServer(server.Handler())
	t.Cleanup(listening.Close)
	return server, listening, logs
}

// logBuffer is the server's log, read by the test while the server writes.
type logBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *logBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Write(p)
}

func (l *logBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.String()
}

func get(t *testing.T, url string, header map[string]string) (*http.Response, string) {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	for name, value := range header {
		if name == "Host" {
			request.Host = value
		} else {
			request.Header.Set(name, value)
		}
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response, string(body)
}

func TestNewFailsWhenTheFirstBuildFails(t *testing.T) {
	failing := &site{err: errors.New("no protos")}
	if _, err := New(context.Background(), Options{Build: failing.build}); err == nil || err.Error() != "no protos" {
		t.Errorf("err = %v, want the build's error", err)
	}
}

func TestStaticFiles(t *testing.T) {
	_, listening, _ := start(t, Options{})
	types := map[string]string{
		"/":              "text/html; charset=utf-8",
		"/index.html":    "text/html; charset=utf-8",
		"/app.js":        "text/javascript; charset=utf-8",
		"/app.css":       "text/css; charset=utf-8",
		"/core.wasm":     "application/wasm",
		"/fonts/a.woff2": "font/woff2",
		"/fonts/OFL.txt": "text/plain; charset=utf-8",
		"/schema.binpb":  "application/octet-stream",
		"/config.json":   "application/json",
	}
	for path, want := range types {
		response, body := get(t, listening.URL+path, nil)
		if response.StatusCode != http.StatusOK || body == "" {
			t.Errorf("%s: %d %q", path, response.StatusCode, body)
		}
		if got := response.Header.Get("Content-Type"); got != want {
			t.Errorf("%s: Content-Type = %q, want %q", path, got, want)
		}
		if response.Header.Get("Cache-Control") != "no-store" || response.Header.Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("%s: headers = %v", path, response.Header)
		}
		csp := response.Header.Get("Content-Security-Policy")
		for _, want := range []string{"default-src 'none'", "script-src 'self' 'wasm-unsafe-eval'", "font-src 'self'", "frame-ancestors 'none'"} {
			if !strings.Contains(csp, want) {
				t.Errorf("%s: Content-Security-Policy = %q, want %s in it", path, csp, want)
			}
		}
		if strings.Contains(csp, "unsafe-inline") || strings.Contains(csp, "'unsafe-eval'") {
			t.Errorf("%s: the policy allows inline script or eval: %q", path, csp)
		}
		for name, want := range map[string]string{
			"X-Frame-Options":              "DENY",
			"Cross-Origin-Resource-Policy": "same-origin",
			"Cross-Origin-Opener-Policy":   "same-origin",
			"Referrer-Policy":              "no-referrer",
		} {
			if got := response.Header.Get(name); got != want {
				t.Errorf("%s: %s = %q, want %q", path, name, got, want)
			}
		}
	}
	if response, _ := get(t, listening.URL+"/nope.txt", nil); response.StatusCode != http.StatusNotFound {
		t.Errorf("a missing file: %d, want 404", response.StatusCode)
	}
	response, err := http.Post(listening.URL+"/", "text/plain", nil)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("POST /: %d, want 405", response.StatusCode)
	}
}

func TestOnlyLoopbackNamesAreServed(t *testing.T) {
	_, listening, _ := start(t, Options{})
	for host, want := range map[string]int{
		"localhost:9000":    http.StatusOK,
		"localhost":         http.StatusOK,
		"127.0.0.1:9000":    http.StatusOK,
		"[::1]:9000":        http.StatusOK,
		"evil.example:9000": http.StatusForbidden,
		"evil.example":      http.StatusForbidden,
		"10.0.0.5:9000":     http.StatusForbidden,
	} {
		if response, _ := get(t, listening.URL+"/", map[string]string{"Host": host}); response.StatusCode != want {
			t.Errorf("Host %s: %d, want %d", host, response.StatusCode, want)
		}
	}
}

func TestBeyondLoopbackOnlyAddressesAndKnownNamesAreServed(t *testing.T) {
	// A name can be pointed at this machine by whoever owns it; an address
	// cannot. So an address is served, and a name only when it was given.
	_, remote, _ := start(t, Options{Remote: true, Hosts: []string{"devbox", "Devbox.local"}})
	for host, want := range map[string]int{
		"localhost:9000":      http.StatusOK,
		"192.168.1.5:9000":    http.StatusOK,
		"10.0.0.5":            http.StatusOK,
		"[fe80::1]:9000":      http.StatusOK,
		"devbox:9000":         http.StatusOK,
		"DEVBOX":              http.StatusOK,
		"devbox.local:9000":   http.StatusOK,
		"evil.example:9000":   http.StatusForbidden,
		"devbox.evil.example": http.StatusForbidden,
		"192.168.1.5.nip.io":  http.StatusForbidden,
	} {
		response, body := get(t, remote.URL+"/", map[string]string{"Host": host})
		if response.StatusCode != want {
			t.Errorf("Host %s: %d, want %d", host, response.StatusCode, want)
		}
		if want == http.StatusForbidden && !strings.Contains(body, "--allow-host") {
			t.Errorf("Host %s: the refusal does not say what to do: %q", host, body)
		}
	}
}

func TestWatchRebuildsAndTellsThePage(t *testing.T) {
	source := &site{files: pages("one")}
	var signature atomic.Value
	signature.Store("a")
	server, listening, logs := start(t, Options{
		Build:     source.build,
		Signature: func() string { return signature.Load().(string) },
		Interval:  5 * time.Millisecond,
	})

	ctx, cancel := context.WithCancel(context.Background())
	stopped := make(chan struct{})
	go func() {
		server.Watch(ctx)
		close(stopped)
	}()

	// The page listens for reloads.
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, listening.URL+"/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	events, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer events.Body.Close()
	if got := events.Header.Get("Content-Type"); got != "text/event-stream" {
		t.Errorf("Content-Type = %q", got)
	}
	lines := make(chan string, 16)
	go func() {
		scanner := bufio.NewScanner(events.Body)
		for scanner.Scan() {
			lines <- scanner.Text()
		}
	}()
	expect := func(want string) {
		t.Helper()
		for {
			select {
			case line := <-lines:
				if line == want {
					return
				}
			case <-time.After(5 * time.Second):
				t.Fatalf("no %q event; logs:\n%s", want, logs)
			}
		}
	}
	expect(": connected")

	// Nothing changed: nothing is built.
	time.Sleep(30 * time.Millisecond)
	if builds := source.count(); builds != 1 {
		t.Errorf("%d builds without a change, want 1", builds)
	}

	source.set(pages("two"), nil)
	signature.Store("b")
	expect("event: reload")
	if _, body := get(t, listening.URL+"/", nil); body != "two" {
		t.Errorf("after a rebuild the page is %q, want %q", body, "two")
	}

	// A build that fails leaves the last good site up.
	source.set(nil, errors.New("syntax error in a.proto"))
	signature.Store("c")
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(logs.String(), "syntax error in a.proto") {
		if time.Now().After(deadline) {
			t.Fatalf("the failed build was not logged:\n%s", logs)
		}
		time.Sleep(5 * time.Millisecond)
	}
	if _, body := get(t, listening.URL+"/", nil); body != "two" {
		t.Errorf("after a failed build the page is %q, want %q", body, "two")
	}

	// A second change, while the listener has not read the first reload.
	source.set(pages("three"), nil)
	signature.Store("d")
	expect("event: reload")
	source.set(pages("four"), nil)
	signature.Store("e")
	source.set(pages("five"), nil)
	signature.Store("f")
	deadline = time.Now().Add(5 * time.Second)
	for {
		if _, body := get(t, listening.URL+"/", nil); body == "five" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the last change was never built")
		}
		time.Sleep(5 * time.Millisecond)
	}

	cancel()
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("Watch did not stop when its context was done")
	}
}

func TestAListenerThatIsBehindIsNotWaitedFor(t *testing.T) {
	source := &site{files: pages("one")}
	var signature atomic.Value
	signature.Store("a")
	server, _, _ := start(t, Options{
		Build:     source.build,
		Signature: func() string { return signature.Load().(string) },
		Interval:  time.Millisecond,
	})
	// A listener with a reload already waiting, as a slow page would have.
	stuck := make(chan struct{}, 1)
	stuck <- struct{}{}
	server.mu.Lock()
	server.listeners[stuck] = struct{}{}
	server.mu.Unlock()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go server.Watch(ctx)
	signature.Store("b")
	deadline := time.Now().Add(5 * time.Second)
	for {
		if source.count() >= 2 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("Watch blocked on a listener that was behind")
		}
		time.Sleep(time.Millisecond)
	}
}

// seen is what the API behind the proxy was asked.
type seen struct {
	Method, Path, RawPath, Query, Host, Body string
	Header                                   http.Header
}

func api(t *testing.T) (*httptest.Server, *seen) {
	t.Helper()
	got := &seen{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		*got = seen{r.Method, r.URL.Path, r.URL.EscapedPath(), r.URL.RawQuery, r.Host, string(body), r.Header.Clone()}
		w.Header().Set("X-From-Api", "yes")
		w.WriteHeader(http.StatusTeapot)
		_, _ = w.Write([]byte("from the api"))
	}))
	t.Cleanup(server.Close)
	return server, got
}

func TestTheProxyForwardsThePagesRequest(t *testing.T) {
	target, got := api(t)
	targetURL, _ := url.Parse(target.URL + "/prefix")
	_, listening, _ := start(t, Options{Target: targetURL})

	request, _ := http.NewRequest(http.MethodPost, listening.URL+"/proxy/v1/widgets/a%2Fb?force=true&key=k%261", strings.NewReader(`{"id":"w"}`))
	request.Header.Set("Authorization", "Bearer s3cr3t")
	request.Header.Set("X-API-Key", "k")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", "http://"+request.URL.Host)
	request.Header.Set("Referer", listening.URL+"/")
	request.Header.Set("Cookie", "session=abc")
	request.Header.Set("Sec-Fetch-Site", "same-origin")
	request.Header.Set("Sec-Fetch-Mode", "cors")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)

	if response.StatusCode != http.StatusTeapot || string(body) != "from the api" || response.Header.Get("X-From-Api") != "yes" {
		t.Errorf("the answer was changed: %d %q %v", response.StatusCode, body, response.Header)
	}
	if got.Method != http.MethodPost || got.Body != `{"id":"w"}` {
		t.Errorf("method and body = %s %q", got.Method, got.Body)
	}
	// The prefix of the target, then the path without /proxy, escapes kept.
	if got.RawPath != "/prefix/v1/widgets/a%2Fb" || got.Path != "/prefix/v1/widgets/a/b" {
		t.Errorf("path = %q (raw %q)", got.Path, got.RawPath)
	}
	if got.Query != "force=true&key=k%261" {
		t.Errorf("query = %q", got.Query)
	}
	if got.Host != targetURL.Host {
		t.Errorf("Host = %q, want the API's %q", got.Host, targetURL.Host)
	}
	if got.Header.Get("Authorization") != "Bearer s3cr3t" || got.Header.Get("X-API-Key") != "k" {
		t.Errorf("the credential was lost: %v", got.Header)
	}
	for _, name := range []string{"Origin", "Referer", "Cookie", "Sec-Fetch-Site", "Sec-Fetch-Mode"} {
		if got.Header.Get(name) != "" {
			t.Errorf("%s reached the API: %q", name, got.Header.Get(name))
		}
	}
}

func TestTheProxyNeverLogsACredential(t *testing.T) {
	target, _ := api(t)
	targetURL, _ := url.Parse(target.URL)
	_, listening, logs := start(t, Options{Target: targetURL})
	get(t, listening.URL+"/proxy/x?key=s3cr3t-key", map[string]string{"Authorization": "Bearer s3cr3t-token", "Sec-Fetch-Site": "same-origin"})
	target.Close()
	get(t, listening.URL+"/proxy/x?key=s3cr3t-key", map[string]string{"Authorization": "Bearer s3cr3t-token", "Sec-Fetch-Site": "same-origin"})
	if strings.Contains(logs.String(), "s3cr3t") {
		t.Errorf("a credential is in the log:\n%s", logs)
	}
}

// page is what a browser adds to a request the site's own page makes.
var page = map[string]string{"Sec-Fetch-Site": "same-origin"}

func TestTheProxyServesThisSiteOnly(t *testing.T) {
	target, got := api(t)
	targetURL, _ := url.Parse(target.URL)
	_, listening, _ := start(t, Options{Target: targetURL})
	for name, header := range map[string]map[string]string{
		"another site's page":     {"Sec-Fetch-Site": "cross-site", "Origin": "https://evil.example"},
		"a cross-site tab":        {"Sec-Fetch-Site": "cross-site"},
		"a same-site tab":         {"Sec-Fetch-Site": "same-site"},
		"typed into the address":  {"Sec-Fetch-Site": "none"},
		"no word from a browser":  nil,
		"an origin, and no more":  {"Origin": listening.URL},
		"a claim in another case": {"Sec-Fetch-Site": "Same-Origin "},
	} {
		response, _ := get(t, listening.URL+"/proxy/x", header)
		if response.StatusCode != http.StatusForbidden {
			t.Errorf("%s: %d, want 403", name, response.StatusCode)
		}
	}
	if got.Path != "" {
		t.Errorf("a refused request reached the API: %+v", got)
	}
	if response, _ := get(t, listening.URL+"/proxy/x", page); response.StatusCode != http.StatusTeapot {
		t.Errorf("the site's own page: %d, want the API's answer", response.StatusCode)
	}
}

func TestBeyondLoopbackTheOriginHasToDo(t *testing.T) {
	// Reached by a name browsers send no Sec-Fetch-Site to.
	target, _ := api(t)
	targetURL, _ := url.Parse(target.URL)
	_, listening, _ := start(t, Options{Target: targetURL, Remote: true})
	for name, c := range map[string]struct {
		header map[string]string
		want   int
	}{
		"no origin":                {nil, http.StatusTeapot},
		"this server's origin":     {map[string]string{"Origin": listening.URL}, http.StatusTeapot},
		"the page, in a browser":   {page, http.StatusTeapot},
		"another origin":           {map[string]string{"Origin": "https://evil.example"}, http.StatusForbidden},
		"a cross-site request":     {map[string]string{"Sec-Fetch-Site": "cross-site"}, http.StatusForbidden},
		"a navigation, by address": {map[string]string{"Sec-Fetch-Site": "none"}, http.StatusForbidden},
	} {
		if response, _ := get(t, listening.URL+"/proxy/x", c.header); response.StatusCode != c.want {
			t.Errorf("%s: %d, want %d", name, response.StatusCode, c.want)
		}
	}
}

func TestTheProxyDoesNotClimb(t *testing.T) {
	target, got := api(t)
	targetURL, _ := url.Parse(target.URL + "/api")
	_, listening, _ := start(t, Options{Target: targetURL})
	for _, path := range []string{"/proxy/../admin", "/proxy/v1/../../admin", "/proxy/v1/%2e%2e/admin", "/proxy/v1/%2E%2E/admin", "/proxy/./x", "/proxy/v1/.."} {
		// Sent as written: a client library would resolve the dots itself.
		request, _ := http.NewRequest(http.MethodGet, listening.URL, nil)
		request.URL.Opaque = path
		request.Header.Set("Sec-Fetch-Site", "same-origin")
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusBadRequest {
			t.Errorf("%s: %d, want 400", path, response.StatusCode)
		}
	}
	if got.Path != "" {
		t.Errorf("a climbing path reached the API: %+v", got)
	}
	// Dots that are part of a name, and an escaped slash, are not a climb.
	for path, want := range map[string]string{
		"/proxy/v1/a..b/...":    "/api/v1/a..b/...",
		"/proxy/v1/a%2F..%2Fb":  "/api/v1/a%2F..%2Fb",
		"/proxy/v1/.well-known": "/api/v1/.well-known",
	} {
		get(t, listening.URL+path, page)
		if got.RawPath != want {
			t.Errorf("%s reached the API as %q, want %q", path, got.RawPath, want)
		}
	}
}

func TestACookieOfTheApiIsNotSetOnThisOrigin(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: "session", Value: "abc"})
		w.Header().Set("X-Kept", "yes")
	}))
	defer target.Close()
	targetURL, _ := url.Parse(target.URL)
	_, listening, _ := start(t, Options{Target: targetURL})
	response, _ := get(t, listening.URL+"/proxy/x", page)
	if response.Header.Get("Set-Cookie") != "" || response.Header.Get("X-Kept") != "yes" {
		t.Errorf("headers = %v", response.Header)
	}
}

func TestAnAnswerOfTheApiIsNotAPageOfThisOrigin(t *testing.T) {
	// An API that answers with a document, and asks for a worker's scope.
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Header().Set("Service-Worker-Allowed", "/")
		w.Header().Set("Content-Security-Policy", "default-src *")
		_, _ = w.Write([]byte("<script>indexedDB.open('wirebook')</script>"))
	}))
	defer target.Close()
	targetURL, _ := url.Parse(target.URL)
	_, listening, _ := start(t, Options{Target: targetURL})
	response, body := get(t, listening.URL+"/proxy/x.html", page)
	if !strings.Contains(body, "<script>") {
		t.Fatalf("the body was changed: %q", body)
	}
	for name, want := range map[string]string{
		"Content-Security-Policy":      "sandbox; default-src 'none'; frame-ancestors 'none'",
		"X-Content-Type-Options":       "nosniff",
		"X-Frame-Options":              "DENY",
		"Cross-Origin-Resource-Policy": "same-origin",
		"Service-Worker-Allowed":       "",
	} {
		if got := strings.Join(response.Header.Values(name), " | "); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
}

func TestWithoutATargetThereIsNoProxy(t *testing.T) {
	_, listening, _ := start(t, Options{})
	response, body := get(t, listening.URL+"/proxy/x", nil)
	if response.StatusCode != http.StatusNotFound || !strings.Contains(body, "--target") {
		t.Errorf("%d %q", response.StatusCode, body)
	}
}

func TestAnApiThatIsDownIsAConnectError(t *testing.T) {
	target, _ := api(t)
	targetURL, _ := url.Parse(target.URL)
	target.Close()
	_, listening, logs := start(t, Options{Target: targetURL})
	response, body := get(t, listening.URL+"/proxy/fixture.v1.WidgetService/GetWidget", page)
	if response.StatusCode != http.StatusBadGateway || response.Header.Get("Content-Type") != "application/json" {
		t.Errorf("%d %v", response.StatusCode, response.Header)
	}
	var connectError struct{ Code, Message string }
	if err := json.Unmarshal([]byte(body), &connectError); err != nil {
		t.Fatalf("the body is not JSON: %q", body)
	}
	if connectError.Code != "unavailable" || !strings.Contains(connectError.Message, "could not reach "+target.URL) {
		t.Errorf("error = %+v", connectError)
	}
	if !strings.Contains(logs.String(), "the proxy could not reach the API") {
		t.Errorf("not logged:\n%s", logs)
	}
}
