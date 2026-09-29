// Package site assembles the explorer: the page, script, style and core that
// are built into this binary, with the descriptor set and the config of one
// repository.
package site

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"fmt"
	"html"
	"os"
	"path/filepath"

	"github.com/g0itb4/wirebook/internal/config"
	"github.com/g0itb4/wirebook/internal/image"
)

// dist is built by `just dist` and committed, so that `go install` and
// `go tool`, which only compile, have it.
//
//go:embed dist
var dist embed.FS

// The names of the files of a site.
const (
	Page   = "index.html"
	Script = "app.js"
	Style  = "app.css"
	Core   = "core.wasm"
	Schema = "schema.binpb"
	Config = "config.json"
)

// What the page says in its source, and what a build replaces it with.
const (
	titleTag  = "<title>" + config.DefaultTitle + "</title>"
	styleTag  = `<link rel="stylesheet" href="app.css" />`
	scriptTag = `<script type="module" src="app.js"></script>`
)

// The policy the page declares for itself, so that it holds on any host: the
// page runs its own script and the core, loads its own style, and calls
// whatever API it is pointed at. Nothing else runs, loads or is embedded.
//
// A site in a directory names its files ('self'). A site in one file names
// them by their hashes, which SingleFile works out.
const (
	policyOfFiles = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; " +
		"connect-src *; base-uri 'none'; form-action 'none'"
	policyOfOneFile = "default-src 'none'; script-src '%s' 'wasm-unsafe-eval'; style-src '%s'; " +
		"connect-src *; base-uri 'none'; form-action 'none'"
)

// hash is the CSP source of an inline element: the SHA-256 of its text.
func hash(text []byte) string {
	sum := sha256.Sum256(text)
	return "sha256-" + base64.StdEncoding.EncodeToString(sum[:])
}

func asset(name string) []byte {
	data, err := dist.ReadFile("dist/" + name)
	if err != nil {
		// The directory is embedded at compile time; a file missing from it
		// is a broken build, not something a caller can handle.
		panic(fmt.Sprintf("site: the embedded %s is missing: run `just dist`", name))
	}
	return data
}

// page is the embedded page with the site's title. A test holds the page to
// having each of the three tags once.
func page(cfg config.Site) []byte {
	title := "<title>" + html.EscapeString(cfg.Title) + "</title>"
	return bytes.Replace(asset(Page), []byte(titleTag), []byte(title), 1)
}

// Files returns a site as the files of a directory, by name.
func Files(img image.Image, cfg config.Site) map[string][]byte {
	return map[string][]byte{
		Page:   page(cfg),
		Script: asset(Script),
		Style:  asset(Style),
		Core:   asset(Core),
		Schema: img.Bytes,
		Config: cfg.JSON(),
	}
}

// SingleFile returns a site as one HTML file, with everything in it. It
// opens from a disk or an artefact store, with no server. The price is a
// third more bytes: the core and the schema are base64.
func SingleFile(img image.Image, cfg config.Site) []byte {
	// A script ends at the first "</script", wherever it is, and "<!--"
	// changes how the rest is read. Escaped, both mean the same to JavaScript.
	script := bytes.ReplaceAll(asset(Script), []byte("</script"), []byte(`<\/script`))
	script = bytes.ReplaceAll(script, []byte("<!--"), []byte(`<\!--`))

	css := asset(Style)
	var style bytes.Buffer
	style.WriteString("<style>")
	style.Write(css)
	style.WriteString("</style>")

	var scripts bytes.Buffer
	scripts.WriteString(`<script type="application/json" id="wirebook-config">`)
	scripts.Write(cfg.JSON())
	scripts.WriteString("</script>\n")
	scripts.WriteString(`<script type="application/octet-stream" id="wirebook-schema">`)
	scripts.WriteString(base64.StdEncoding.EncodeToString(img.Bytes))
	scripts.WriteString("</script>\n")
	scripts.WriteString(`<script type="application/octet-stream" id="wirebook-core">`)
	scripts.WriteString(base64.StdEncoding.EncodeToString(asset(Core)))
	scripts.WriteString("</script>\n")
	scripts.WriteString(`<script type="module">`)
	scripts.Write(script)
	scripts.WriteString("</script>")

	index := bytes.Replace(page(cfg), []byte(styleTag), style.Bytes(), 1)
	index = bytes.Replace(index, []byte(scriptTag), scripts.Bytes(), 1)
	// The two data blocks are not scripts to a browser, and need no hash.
	policy := fmt.Sprintf(policyOfOneFile, hash(script), hash(css))
	return bytes.Replace(index, []byte(policyOfFiles), []byte(policy), 1)
}

// Write puts the files in dir, which it creates.
//
// The repository a site is built in may not be one's own. Nothing is written
// through a symbolic link: not the directory, and not a file in it, which a
// hostile repository could have pointed at a file elsewhere.
func Write(dir string, files map[string][]byte) error {
	if info, err := os.Lstat(dir); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s is a symbolic link: wirebook writes into a directory of its own", dir)
	}
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return err
	}
	for name, data := range files {
		if err := WriteFile(filepath.Join(dir, name), data); err != nil {
			return err
		}
	}
	return nil
}

// temporary is where WriteFile writes before it renames.
func temporary(path string) string {
	return filepath.Join(filepath.Dir(path), fmt.Sprintf(".%s.%d.tmp", filepath.Base(path), os.Getpid()))
}

// WriteFile puts data at path by writing a new file beside it and renaming
// that over it. A rename replaces a link; it does not follow it. The new
// file is created only if nothing has its name, link or not.
func WriteFile(path string, data []byte) error {
	tmp := temporary(path)
	// 0644: a site is served, often by another user than the one who built it.
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644) //nolint:gosec // G302, G304: see above; the path is the command's --out.
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(tmp, path)
	}
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}
