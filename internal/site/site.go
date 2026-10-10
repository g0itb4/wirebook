// Package site assembles the explorer: the page, script, style, fonts and
// core that are built into this binary, with the descriptor set and the
// config of one repository.
package site

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"html"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"

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

// Fonts are the two typefaces of the page, as the style names them. They are
// files of the site: the page loads nothing from another origin.
var Fonts = []string{"fonts/jetbrains-mono.woff2", "fonts/space-grotesk.woff2"}

// FontLicence is the licence of the two typefaces, the SIL Open Font License,
// which asks to be kept with them. The one-file site has their notice in its
// style.
const FontLicence = "fonts/OFL.txt"

// What the page says in its source, and what a build replaces it with.
const (
	titleTag       = "<title>" + config.DefaultTitle + "</title>"
	brandTag       = `<a class="brand" href="#/">` + config.DefaultTitle + `</a>`
	descriptionTag = `<meta name="description" content="` + config.DefaultTitle + `" />`
	ogTitleTag     = `<meta property="og:title" content="` + config.DefaultTitle + `" />`
	styleTag       = `<link rel="stylesheet" href="app.css" />`
	scriptTag      = `<script type="module" src="app.js"></script>`
)

// The page's head asks for its files before its script runs. A site in one
// file has nothing to ask for, and drops them.
var preloadTags = []string{
	`<link rel="modulepreload" href="app.js" />`,
	`<link rel="preload" href="core.wasm" as="fetch" crossorigin />`,
	`<link rel="preload" href="schema.binpb" as="fetch" crossorigin />`,
	`<link rel="preload" href="config.json" as="fetch" crossorigin />`,
	`<link rel="preload" href="fonts/space-grotesk.woff2" as="font" type="font/woff2" crossorigin />`,
	`<link rel="preload" href="fonts/jetbrains-mono.woff2" as="font" type="font/woff2" crossorigin />`,
}

// The policy the page declares for itself, so that it holds on any host: the
// page runs its own script and the core, loads its own style and fonts, and
// calls whatever API it is pointed at. Nothing else runs, loads or is
// embedded.
//
// A site in a directory names its files ('self'). A site in one file names
// its script and style by their hashes, which SingleFile works out, and
// holds its fonts in the style (data:). The one image is the icon, drawn in
// the page itself (img-src data:): nothing is fetched for it.
const (
	policyOfFiles = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; " +
		"font-src 'self'; img-src data:; connect-src *; base-uri 'none'; form-action 'none'"
	policyOfOneFile = "default-src 'none'; script-src '%s' 'wasm-unsafe-eval'; style-src '%s'; " +
		"font-src data:; img-src data:; connect-src *; base-uri 'none'; form-action 'none'"
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

// page is the embedded page with the site's title: in its head, where a link
// to it is previewed, and on the brand the page shows while the core loads. A
// test holds the page to having each tag once.
func page(cfg config.Site) []byte {
	title := html.EscapeString(cfg.Title)
	index := asset(Page)
	for _, tag := range [][2]string{
		{titleTag, "<title>" + title + "</title>"},
		{brandTag, `<a class="brand" href="#/">` + title + `</a>`},
		{descriptionTag, `<meta name="description" content="` + title + `: every method documented, and a console that calls it." />`},
		{ogTitleTag, `<meta property="og:title" content="` + title + `" />`},
	} {
		index = bytes.Replace(index, []byte(tag[0]), []byte(tag[1]), 1)
	}
	return index
}

// In a directory, the files of the build carry a hash of their bytes in
// their name: app.1a2b3c4d.js. A host may then tell a browser to keep them
// for good, and a page from a new build never meets a file of an old one.
// The schema and the config are the site's own, named plainly: they change
// with every build, and are served so that a browser asks again.
//
// The style names the fonts, so the fonts are named first and the style is
// hashed with their new names in it.
type build struct {
	names map[string]string
	style []byte
}

var hashedBuild = sync.OnceValue(func() build {
	named := func(name string, data []byte) string {
		sum := sha256.Sum256(data)
		ext := path.Ext(name)
		return strings.TrimSuffix(name, ext) + "." + hex.EncodeToString(sum[:4]) + ext
	}
	names := map[string]string{}
	style := asset(Style)
	for _, font := range Fonts {
		names[font] = named(font, asset(font))
		style = bytes.Replace(style, []byte(font), []byte(names[font]), 1)
	}
	names[Style] = named(Style, style)
	names[Script] = named(Script, asset(Script))
	names[Core] = named(Core, asset(Core))
	return build{names, style}
})

// Name is what a file of the build is called in a directory site: the
// source name with a hash in it. A name that is not the build's is its own.
func Name(source string) string {
	if hashed, ok := hashedBuild().names[source]; ok {
		return hashed
	}
	return source
}

// pageOfFiles is the page of a directory site: it asks for the build's files
// by their hashed names.
func pageOfFiles(cfg config.Site) []byte {
	index := page(cfg)
	for source, hashed := range hashedBuild().names {
		index = bytes.ReplaceAll(index, []byte(`="`+source+`"`), []byte(`="`+hashed+`"`))
	}
	return index
}

// Files returns a site as the files of a directory, by name.
func Files(img image.Image, cfg config.Site) map[string][]byte {
	build := hashedBuild()
	files := map[string][]byte{
		Page:                pageOfFiles(cfg),
		build.names[Script]: asset(Script),
		build.names[Style]:  build.style,
		build.names[Core]:   asset(Core),
		Schema:              img.Bytes,
		Config:              cfg.JSON(),
	}
	for _, font := range Fonts {
		files[build.names[font]] = asset(font)
	}
	files[FontLicence] = asset(FontLicence)
	return files
}

// styleOfOneFile is the style with each font in it, where the style of a
// directory names a file.
func styleOfOneFile() []byte {
	css := asset(Style)
	for _, font := range Fonts {
		data := "data:font/woff2;base64," + base64.StdEncoding.EncodeToString(asset(font))
		css = bytes.Replace(css, []byte(font), []byte(data), 1)
	}
	return css
}

// SingleFile returns a site as one HTML file, with everything in it. It
// opens from a disk or an artefact store, with no server. The price is a
// third more bytes: the core and the schema are base64.
func SingleFile(img image.Image, cfg config.Site) []byte {
	// A script ends at the first "</script", wherever it is, and "<!--"
	// changes how the rest is read. Escaped, both mean the same to JavaScript.
	script := bytes.ReplaceAll(asset(Script), []byte("</script"), []byte(`<\/script`))
	script = bytes.ReplaceAll(script, []byte("<!--"), []byte(`<\!--`))

	css := styleOfOneFile()
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
	for _, tag := range preloadTags {
		index = bytes.Replace(index, []byte("    "+tag+"\n"), nil, 1)
	}
	// The two data blocks are not scripts to a browser, and need no hash.
	policy := fmt.Sprintf(policyOfOneFile, hash(script), hash(css))
	return bytes.Replace(index, []byte(policyOfFiles), []byte(policy), 1)
}

// directory makes dir, unless it is there. It is not a symbolic link.
func directory(dir string) error {
	if info, err := os.Lstat(dir); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s is a symbolic link: wirebook writes into a directory of its own", dir)
	}
	return os.MkdirAll(dir, 0o750)
}

// Write puts the files in dir, which it creates. A name may hold one
// directory: "fonts/a.woff2".
//
// The repository a site is built in may not be one's own. Nothing is written
// through a symbolic link: not the directory, not a directory in it, and not
// a file, which a hostile repository could have pointed at a file elsewhere.
func Write(dir string, files map[string][]byte) error {
	if err := directory(dir); err != nil {
		return err
	}
	for name, data := range files {
		path := filepath.Join(dir, filepath.FromSlash(name))
		if parent := filepath.Dir(path); parent != filepath.Clean(dir) {
			if err := directory(parent); err != nil {
				return err
			}
		}
		if err := WriteFile(path, data); err != nil {
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
