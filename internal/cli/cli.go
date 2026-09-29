// Package cli is the wirebook command: build a site, or serve one while the
// protos are being written.
package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"hash/fnv"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/g0itb4/wirebook/internal/bufcli"
	"github.com/g0itb4/wirebook/internal/config"
	"github.com/g0itb4/wirebook/internal/image"
	"github.com/g0itb4/wirebook/internal/serve"
	"github.com/g0itb4/wirebook/internal/site"
)

// Version is the release, set at build time with -ldflags.
var Version = "dev"

const usage = `wirebook turns proto files into a browsable, callable API explorer.

Usage:
  wirebook build [flags]    write the site: a directory, or one HTML file
  wirebook serve [flags]    serve the site, rebuild it when a proto changes,
                            and proxy requests to the API
  wirebook version

Both commands read the protos of the buf module in the current directory.
Run "wirebook build -h" or "wirebook serve -h" for the flags.
`

// Run executes the command line and returns the exit code. It returns when
// the command is done; for serve, that is when ctx is.
func Run(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		_, _ = fmt.Fprint(stderr, usage)
		return 2
	}
	var err error
	switch args[0] {
	case "build":
		err = build(ctx, args[1:], stdout, stderr)
	case "serve":
		err = serveSite(ctx, args[1:], stdout, stderr)
	case "version", "-v", "--version":
		_, _ = fmt.Fprintln(stdout, "wirebook", Version)
	case "help", "-h", "--help":
		_, _ = fmt.Fprint(stdout, usage)
	default:
		_, _ = fmt.Fprintf(stderr, "wirebook: unknown command %q\n\n%s", args[0], usage)
		return 2
	}
	switch {
	case err == nil:
		return 0
	case errors.Is(err, flag.ErrHelp):
		return 0
	case errors.Is(err, errUsage):
		return 2
	default:
		_, _ = fmt.Fprintln(stderr, "wirebook:", err)
		return 1
	}
}

// errUsage is a command line that the flag package has already complained
// about.
var errUsage = errors.New("usage")

// source is where the schema and the config come from.
type source struct {
	image  string
	dir    string
	buf    string
	config string
}

func (s *source) flags(set *flag.FlagSet) {
	set.StringVar(&s.dir, "dir", ".", "the directory of the buf module")
	set.StringVar(&s.image, "image", "", "a descriptor set or Buf image to read, instead of running buf")
	set.StringVar(&s.buf, "buf", "buf", `the words that run buf, such as "bunx buf"`)
	set.StringVar(&s.config, "config", "", "the config file (default: wirebook.json in --dir, when there is one)")
}

func (s *source) configPath() string {
	if s.config != "" {
		return s.config
	}
	return config.Discover(s.dir)
}

func (s *source) load(ctx context.Context) (image.Image, config.File, error) {
	file, err := config.Load(s.configPath())
	if err != nil {
		return image.Image{}, config.File{}, err
	}
	var data []byte
	if s.image != "" {
		data, err = os.ReadFile(s.image)
	} else {
		data, err = bufcli.Build(ctx, strings.Fields(s.buf), s.dir)
	}
	if err != nil {
		return image.Image{}, config.File{}, err
	}
	img, err := image.FromBytes(data)
	return img, file, err
}

// The directories a watch does not descend into: they hold no proto of the
// module, and some hold a great many files.
var skipped = map[string]bool{".git": true, "node_modules": true, "target": true, "vendor": true}

// signature changes when an input of the build does: a proto, buf's own
// files, the config, or the image.
func (s *source) signature() string {
	hash := fnv.New64a()
	note := func(path string) {
		if info, err := os.Stat(path); err == nil {
			_, _ = fmt.Fprintf(hash, "%s %d %d\n", path, info.Size(), info.ModTime().UnixNano())
		}
	}
	note(s.configPath())
	if s.image != "" {
		note(s.image)
		return fmt.Sprint(hash.Sum64())
	}
	_ = filepath.WalkDir(s.dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return nil //nolint:nilerr // A directory that cannot be read has no proto to watch.
		}
		name := entry.Name()
		if entry.IsDir() {
			if skipped[name] && path != s.dir {
				return fs.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(name, ".proto") || name == "buf.yaml" || name == "buf.lock" {
			note(path)
		}
		return nil
	})
	return fmt.Sprint(hash.Sum64())
}

func parse(set *flag.FlagSet, args []string, stderr io.Writer) error {
	set.SetOutput(stderr)
	if err := set.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return err
		}
		return errUsage
	}
	if set.NArg() > 0 {
		_, _ = fmt.Fprintf(stderr, "unexpected argument %q\n", set.Arg(0))
		set.Usage()
		return errUsage
	}
	return nil
}

func build(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	var src source
	set := flag.NewFlagSet("wirebook build", flag.ContinueOnError)
	src.flags(set)
	out := set.String("out", "site", "the directory to write the site to")
	single := set.String("single-file", "", "write one HTML file with everything in it, to this path, instead of a directory")
	if err := parse(set, args, stderr); err != nil {
		return err
	}

	img, file, err := src.load(ctx)
	if err != nil {
		return err
	}
	cfg := file.Site(img.ID(), img.Roots, false)
	if *single != "" {
		if err := os.MkdirAll(filepath.Dir(*single), 0o750); err != nil {
			return err
		}
		if err := site.WriteFile(*single, site.SingleFile(img, cfg)); err != nil {
			return err
		}
		_, _ = fmt.Fprintf(stdout, "wrote %s: %d proto files documented\n", *single, len(img.Roots))
		return nil
	}
	if err := site.Write(*out, site.Files(img, cfg)); err != nil {
		return err
	}
	_, _ = fmt.Fprintf(stdout, "wrote %s: %d proto files documented\n", *out, len(img.Roots))
	return nil
}

func serveSite(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	var src source
	set := flag.NewFlagSet("wirebook serve", flag.ContinueOnError)
	src.flags(set)
	addr := set.String("addr", "127.0.0.1:9000", "the address to listen on")
	target := set.String("target", "", "the API to proxy to, such as http://localhost:8080")
	interval := set.Duration("interval", 500*time.Millisecond, "how often to look for a changed proto")
	allowed := set.String("allow-host", "", "names this machine is reached by, separated by commas, when --addr is not a loopback address (its own host name is always one)")
	if err := parse(set, args, stderr); err != nil {
		return err
	}

	var api *url.URL
	if *target != "" {
		parsed, err := url.Parse(*target)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
			return fmt.Errorf("--target must be an http or https URL, such as http://localhost:8080; got %q", *target)
		}
		// The target is written into the site's config, for the curl command.
		if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
			return errors.New("--target must not carry a user name, a password, a query or a fragment")
		}
		api = parsed
	}
	if *interval <= 0 {
		return errors.New("--interval must be more than zero")
	}

	log := slog.New(slog.NewTextHandler(stderr, nil))
	server, err := serve.New(ctx, serve.Options{
		Build: func(ctx context.Context) (map[string][]byte, error) {
			img, file, err := src.load(ctx)
			if err != nil {
				return nil, err
			}
			if api != nil {
				// First, so it is what a new visitor starts with: it works
				// whatever the API's CORS rules are.
				proxy := config.Environment{Name: "Proxy to " + api.Host, BaseURL: serve.ProxyPath, DirectURL: strings.TrimSuffix(api.String(), "/")}
				file.Environments = append([]config.Environment{proxy}, file.Environments...)
			}
			return site.Files(img, file.Site(img.ID(), img.Roots, true)), nil
		},
		Signature: src.signature,
		Interval:  *interval,
		Target:    api,
		Remote:    !loopbackAddr(*addr),
		Hosts:     hosts(*allowed),
		Log:       log,
	})
	if err != nil {
		return err
	}

	listener, err := (&net.ListenConfig{}).Listen(ctx, "tcp", *addr)
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintf(stdout, "wirebook: http://%s\n", listener.Addr())
	if api != nil {
		_, _ = fmt.Fprintf(stdout, "wirebook: /proxy forwards to %s\n", api)
	}
	if !loopbackAddr(*addr) {
		_, _ = fmt.Fprintf(stderr, "wirebook: warning: %s is not a loopback address. Whoever can reach it can read the site", *addr)
		if api != nil {
			_, _ = fmt.Fprintf(stderr, " and use the proxy to %s", api)
		}
		_, _ = fmt.Fprintln(stderr, ".")
	}

	watching, stop := context.WithCancel(ctx)
	defer stop()
	go server.Watch(watching)

	httpServer := &http.Server{Handler: server.Handler(), ReadHeaderTimeout: 10 * time.Second}
	done := make(chan error, 1)
	go func() { done <- httpServer.Serve(listener) }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		// The pages' event streams never end on their own: close them.
		_ = httpServer.Close()
		<-done
		return nil
	}
}

// hosts are the names the server answers to beyond loopback: the ones
// given, and this machine's own.
func hosts(allowed string) []string {
	names := strings.FieldsFunc(allowed, func(r rune) bool { return r == ',' || r == ' ' })
	if name, err := os.Hostname(); err == nil && name != "" {
		names = append(names, name)
	}
	return names
}

// loopbackAddr reports whether a listen address is reachable from this
// machine only.
func loopbackAddr(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
