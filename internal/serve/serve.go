// Package serve is the development server: the site, rebuilt when its inputs
// change, and a proxy to the API for a page that the API's CORS rules would
// not let through.
package serve

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"path"
	"slices"
	"strings"
	"sync"
	"time"
)

// ProxyPath is where the proxy listens. The page's proxy environment has it
// as its base URL.
const ProxyPath = "/proxy"

// Options configure a Server.
type Options struct {
	// Build makes the files of the site, by name.
	Build func(context.Context) (map[string][]byte, error)
	// Signature describes the inputs of Build. When it changes, the site is
	// built again.
	Signature func() string
	// Interval is how often Signature is asked.
	Interval time.Duration
	// Target is the API the proxy forwards to. Nil: no proxy.
	Target *url.URL
	// Remote says the server listens beyond this machine. It then answers
	// to any address, and to the names in Hosts, besides the loopback names.
	//
	// It never answers to a name it was not told: a page elsewhere could
	// otherwise reach this server, as its own origin, by pointing a name of
	// its own at this machine's address (DNS rebinding). An address cannot
	// be pointed anywhere.
	Remote bool
	// Hosts are the names this machine is known by, without a port.
	Hosts []string
	Log   *slog.Logger
}

// Server serves one site.
type Server struct {
	opts  Options
	proxy *httputil.ReverseProxy

	// built is the signature of the inputs the site was last built from.
	built string

	mu        sync.RWMutex
	files     map[string][]byte
	listeners map[chan struct{}]struct{}
}

// New builds the site once and returns its server.
func New(ctx context.Context, opts Options) (*Server, error) {
	// Read before the build: a change made while it runs is then seen by
	// Watch, and built.
	built := ""
	if opts.Signature != nil {
		built = opts.Signature()
	}
	files, err := opts.Build(ctx)
	if err != nil {
		return nil, err
	}
	s := &Server{opts: opts, built: built, files: files, listeners: map[chan struct{}]struct{}{}}
	if opts.Target != nil {
		s.proxy = &httputil.ReverseProxy{
			Rewrite:       s.rewrite,
			FlushInterval: -1, // A stream reaches the page frame by frame.
			ErrorHandler:  s.unreachable,
			// A cookie of the API would be set on this origin, where the
			// page never sends one back: it has no use, so it gets no place.
			ModifyResponse: func(response *http.Response) error {
				header := response.Header
				header.Del("Set-Cookie")
				// The answer is data for the page's `fetch`. Opened as a
				// document it would be a page of this origin, with this
				// origin's store: so it is one that can do nothing, cannot be
				// framed or loaded by another site, and registers no worker.
				header.Set("Content-Security-Policy", "sandbox; default-src 'none'; frame-ancestors 'none'")
				header.Set("X-Content-Type-Options", "nosniff")
				header.Set("X-Frame-Options", "DENY")
				header.Set("Cross-Origin-Resource-Policy", "same-origin")
				header.Del("Service-Worker-Allowed")
				return nil
			},
		}
	}
	return s, nil
}

// Watch rebuilds the site whenever the signature of its inputs changes,
// until ctx is done. A build that fails is logged, and the last good site
// stays up.
func (s *Server) Watch(ctx context.Context) {
	last := s.built
	ticker := time.NewTicker(s.opts.Interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		now := s.opts.Signature()
		if now == last {
			continue
		}
		last = now
		files, err := s.opts.Build(ctx)
		if err != nil {
			s.opts.Log.Error("rebuild failed; the last good site stays up", "error", err)
			continue
		}
		s.mu.Lock()
		s.files = files
		for listener := range s.listeners {
			// A listener that has not read the last reload needs no second.
			select {
			case listener <- struct{}{}:
			default:
			}
		}
		s.mu.Unlock()
		s.opts.Log.Info("rebuilt")
	}
}

// Handler serves the site, its reload events and the proxy.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /events", s.events)
	mux.HandleFunc("GET /", s.static)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.answersTo(r.Host) {
			http.Error(w, "wirebook serve does not answer to this name; if it is this machine's, pass it with --allow-host", http.StatusForbidden)
			return
		}
		// The proxy takes every method, the site only GET; the mux cannot
		// hold both patterns, so the proxy is told apart here.
		if strings.HasPrefix(r.URL.Path, ProxyPath+"/") {
			s.forward(w, r)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

// answersTo reports whether a request addressed to hostport is for this
// server.
func (s *Server) answersTo(hostport string) bool {
	if loopback(hostport) {
		return true
	}
	if !s.opts.Remote {
		return false
	}
	host := hostname(hostport)
	if net.ParseIP(host) != nil {
		return true
	}
	return slices.ContainsFunc(s.opts.Hosts, func(name string) bool { return strings.EqualFold(name, host) })
}

// hostname is the host of a Host header, without port and brackets.
func hostname(hostport string) string {
	host := hostport
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		host = h
	}
	return strings.Trim(host, "[]")
}

func loopback(hostport string) bool {
	host := hostname(hostport)
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

var contentTypes = map[string]string{
	".html":  "text/html; charset=utf-8",
	".js":    "text/javascript; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".json":  "application/json",
	".wasm":  "application/wasm",
	".binpb": "application/octet-stream",
}

// The page runs its own script and the core, and calls any API it is pointed
// at. Nothing else: no inline script, no frame, no plugin.
const contentSecurityPolicy = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; " +
	"connect-src *; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

func (s *Server) static(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/")
	if name == "" {
		name = "index.html"
	}
	s.mu.RLock()
	data, ok := s.files[name]
	s.mu.RUnlock()
	if !ok {
		http.NotFound(w, r)
		return
	}
	header := w.Header()
	header.Set("Content-Type", contentTypes[path.Ext(name)])
	header.Set("Cache-Control", "no-store")
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("Content-Security-Policy", contentSecurityPolicy)
	header.Set("Referrer-Policy", "no-referrer")
	// For a browser that does not know frame-ancestors, and so that no other
	// site can load these files as its own, or keep a handle on this window.
	header.Set("X-Frame-Options", "DENY")
	header.Set("Cross-Origin-Resource-Policy", "same-origin")
	header.Set("Cross-Origin-Opener-Policy", "same-origin")
	_, _ = w.Write(data)
}

// events is a server-sent event stream: one "reload" per rebuild.
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	header := w.Header()
	header.Set("Content-Type", "text/event-stream")
	header.Set("Cache-Control", "no-store")
	controller := http.NewResponseController(w)
	_, _ = fmt.Fprint(w, ": connected\n\n")
	_ = controller.Flush()

	listener := make(chan struct{}, 1)
	s.mu.Lock()
	s.listeners[listener] = struct{}{}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.listeners, listener)
		s.mu.Unlock()
	}()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-listener:
			_, _ = fmt.Fprint(w, "event: reload\ndata: rebuilt\n\n")
			_ = controller.Flush()
		}
	}
}

// forward passes a request of the page on to the API. Only the page itself
// may use it: the proxy would otherwise lend this machine's reach to any
// site open in the browser.
func (s *Server) forward(w http.ResponseWriter, r *http.Request) {
	if s.proxy == nil {
		http.Error(w, "this server has no proxy: start it with --target", http.StatusNotFound)
		return
	}
	if !s.fromThisSite(r) {
		http.Error(w, "the proxy serves this site only", http.StatusForbidden)
		return
	}
	if climbs(r.URL.EscapedPath()) {
		http.Error(w, "the path has a . or .. segment", http.StatusBadRequest)
		return
	}
	s.proxy.ServeHTTP(w, r)
}

// fromThisSite reports whether a request was made by the page this server
// serves.
//
// On a loopback name a browser says so itself: every request carries
// Sec-Fetch-Site, which a page cannot set, and only the site's own page gets
// "same-origin". A request without it is not from a current browser, and is
// refused: curl has no use for the proxy, it can reach the API.
//
// Bound to another address the server is reached over plain http by a name
// browsers do not trust with that header, so the Origin has to do: it must
// be this server's when there is one. That is weaker, and so is the setting:
// whoever can reach the address can use the proxy.
func (s *Server) fromThisSite(r *http.Request) bool {
	site := r.Header.Get("Sec-Fetch-Site")
	if !s.opts.Remote {
		return site == "same-origin"
	}
	if origin := r.Header.Get("Origin"); origin != "" && origin != "http://"+r.Host {
		return false
	}
	return site == "" || site == "same-origin"
}

// climbs reports whether an escaped path has a segment that is "." or "..",
// written out or escaped. The API would resolve it, and answer for another
// path than the one the page showed.
func climbs(escapedPath string) bool {
	for _, segment := range strings.Split(escapedPath, "/") {
		segment = strings.ReplaceAll(strings.ReplaceAll(segment, "%2e", "."), "%2E", ".")
		if segment == "." || segment == ".." {
			return true
		}
	}
	return false
}

func (s *Server) rewrite(r *httputil.ProxyRequest) {
	// The escaped form goes along: a path variable may hold an escaped slash.
	r.Out.URL.Path = strings.TrimPrefix(r.In.URL.Path, ProxyPath)
	r.Out.URL.RawPath = strings.TrimPrefix(r.In.URL.RawPath, ProxyPath)
	r.SetURL(s.opts.Target)
	r.Out.Host = s.opts.Target.Host
	// The API sees a client like curl, not a browser on another origin: it
	// has no CORS decision to make, and gets no cookie of this origin.
	for _, name := range []string{"Origin", "Referer", "Cookie", "Sec-Fetch-Site", "Sec-Fetch-Mode", "Sec-Fetch-Dest"} {
		r.Out.Header.Del(name)
	}
}

// unreachable answers in the shape of a Connect error, so the console shows
// the reason where it shows any other error.
func (s *Server) unreachable(w http.ResponseWriter, _ *http.Request, err error) {
	s.opts.Log.Error("the proxy could not reach the API", "target", s.opts.Target.String(), "error", err)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusBadGateway)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"code":    "unavailable",
		"message": fmt.Sprintf("wirebook's proxy could not reach %s: %v", s.opts.Target, err),
	})
}
