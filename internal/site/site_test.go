package site

import (
	"bytes"
	"encoding/base64"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/g0itb4/wirebook/internal/config"
	"github.com/g0itb4/wirebook/internal/image"
)

var (
	img = image.Image{Bytes: []byte("the schema"), Roots: []string{"a.proto"}}
	cfg = config.File{Title: `Widgets <&> "API"`}.Site("abc123", []string{"a.proto"}, false)
)

func TestFiles(t *testing.T) {
	files := Files(img, cfg)
	for _, name := range []string{Page, Script, Style, Core, Schema, Config} {
		if len(files[Name(name)]) == 0 {
			t.Errorf("%s is missing or empty", Name(name))
		}
	}
	// The build's files carry a hash: app.1a2b3c4d.js. The site's own do not.
	for _, name := range []string{Script, Style, Core, Fonts[0]} {
		if !regexp.MustCompile(`^[a-z/-]+\.[0-9a-f]{8}\.[a-z0-9]+$`).MatchString(Name(name)) {
			t.Errorf("Name(%s) = %s, want a hash in it", name, Name(name))
		}
	}
	for _, name := range []string{Page, Schema, Config, FontLicence} {
		if Name(name) != name {
			t.Errorf("Name(%s) = %s, want it unchanged", name, Name(name))
		}
	}
	for _, font := range Fonts {
		if !bytes.HasPrefix(files[Name(font)], []byte("wOF2")) {
			t.Errorf("%s is not a WOFF2 font", Name(font))
		}
		// The style asks for each font by the name it is written under.
		if !bytes.Contains(files[Name(Style)], []byte(`url(`+Name(font)+`)`)) {
			t.Errorf("the style does not load %s", Name(font))
		}
	}
	if !bytes.Contains(files[FontLicence], []byte("SIL Open Font License")) {
		t.Errorf("%s is not the fonts' licence", FontLicence)
	}
	if len(files) != 9 {
		t.Errorf("%d files, want 9", len(files))
	}
	if string(files[Schema]) != "the schema" {
		t.Errorf("schema = %q", files[Schema])
	}
	if !bytes.HasPrefix(files[Name(Core)], []byte("\x00asm")) {
		t.Error("core.wasm is not a WebAssembly module")
	}
	index := string(files[Page])
	// The page asks for the build's files by their hashed names, and for the
	// site's own by theirs.
	for _, name := range []string{Script, Style, Core, Fonts[0], Fonts[1]} {
		if !strings.Contains(index, `="`+Name(name)+`"`) || strings.Contains(index, `="`+name+`"`) {
			t.Errorf("the page does not ask for %s as %s", name, Name(name))
		}
	}
	if !strings.Contains(index, `href="schema.binpb"`) || !strings.Contains(index, `href="config.json"`) {
		t.Error("the page does not ask for the schema and the config by their plain names")
	}
	if !strings.Contains(index, "<title>Widgets &lt;&amp;&gt; &#34;API&#34;</title>") {
		t.Errorf("the title is not set, or not escaped:\n%s", index)
	}
	if !strings.Contains(index, `<a class="brand" href="#/">Widgets &lt;&amp;&gt; &#34;API&#34;</a>`) {
		t.Errorf("the brand shown while loading is not the title, escaped:\n%s", index)
	}
	for _, meta := range []string{
		`<meta name="description" content="Widgets &lt;&amp;&gt; &#34;API&#34;: every method documented, and a console that calls it." />`,
		`<meta property="og:title" content="Widgets &lt;&amp;&gt; &#34;API&#34;" />`,
		`href="data:image/svg+xml,`,
	} {
		if !strings.Contains(index, meta) {
			t.Errorf("the page's head lacks %s", meta)
		}
	}
	if !strings.Contains(index, `<script type="module" src="`+Name(Script)+`"></script>`) ||
		!strings.Contains(index, `<link rel="stylesheet" href="`+Name(Style)+`" />`) {
		t.Error("a directory site loads its script and style from files, by their hashed names")
	}
	want := `{"id":"abc123","title":"Widgets \u003c\u0026\u003e \"API\"","roots":["a.proto"],"environments":[],"auth":[],"lookups":{},"links":[],"liveReload":false}`
	if string(files[Config]) != want {
		t.Errorf("config = %s, want %s", files[Config], want)
	}
}

func TestSingleFileHoldsEverything(t *testing.T) {
	text := string(SingleFile(img, cfg))
	// The script itself reads `link[rel="preload"]`, so the tags are looked
	// for whole, not by that word.
	gone := append([]string{scriptTag, styleTag, `src="`, `href="app`, `url(fonts/`, `modulepreload`}, preloadTags...)
	for _, tag := range gone {
		if strings.Contains(text, tag) {
			t.Errorf("the file still refers to another one: %s", tag)
		}
	}
	for _, want := range []string{
		"<title>Widgets &lt;&amp;&gt; &#34;API&#34;</title>",
		"<style>",
		// The fonts are in the file, and so is their notice.
		"url(data:font/woff2;base64,",
		"SIL Open Font License",
		`<script type="application/json" id="wirebook-config">{"id":"abc123","title":"Widgets \u003c\u0026\u003e`,
		`<script type="application/octet-stream" id="wirebook-schema">` + base64.StdEncoding.EncodeToString([]byte("the schema")) + "</script>",
		`<script type="application/octet-stream" id="wirebook-core">AGFzbQ`,
		`<script type="module">`,
	} {
		if !strings.Contains(text, want) {
			t.Errorf("the file lacks %s", want)
		}
	}
	// Four scripts open, four close: none was ended early by its content.
	if open, closed := strings.Count(text, "<script"), strings.Count(text, "</script>"); open != 4 || closed != 4 {
		t.Errorf("%d scripts open and %d close, want 4 and 4", open, closed)
	}
	if strings.Contains(text, "<!--") {
		t.Error("the file has an HTML comment opener, which changes how a script is read")
	}
}

func TestEachSiteDeclaresItsPolicy(t *testing.T) {
	// A directory: its own files, by 'self'.
	index := string(Files(img, cfg)[Page])
	if !strings.Contains(index, `http-equiv="Content-Security-Policy"`) || !strings.Contains(index, "script-src 'self' 'wasm-unsafe-eval'; style-src 'self';") {
		t.Errorf("the directory site has no policy:\n%s", index)
	}

	// One file: the script and the style by the hash of their text, and no
	// 'self', no 'unsafe-inline'.
	text := string(SingleFile(img, cfg))
	between := func(open, end string) string {
		start := strings.Index(text, open) + len(open)
		return text[start : start+strings.Index(text[start:], end)]
	}
	script := between(`<script type="module">`, "</script>")
	style := between("<style>", "</style>")
	want := "script-src '" + hash([]byte(script)) + "' 'wasm-unsafe-eval'; style-src '" + hash([]byte(style)) + "';"
	if !strings.Contains(text, want) {
		t.Errorf("the single file's policy does not name its script and style by hash; want %s", want)
	}
	policy := between(`content="default-src`, `"`)
	for _, loose := range []string{"'self'", "unsafe-inline", "unsafe-eval' "} {
		if strings.Contains(policy, loose) && loose != "unsafe-eval' " {
			t.Errorf("the single file's policy has %s: %s", loose, policy)
		}
	}
	if strings.Contains(policy, "'unsafe-eval'") {
		t.Errorf("the policy allows eval: %s", policy)
	}
	// A known vector: the hash of "abc".
	if got := hash([]byte("abc")); got != "sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=" {
		t.Errorf("hash(abc) = %s", got)
	}
}

func TestPageNeedsItsMarkers(t *testing.T) {
	// The page is read from the build. Each tag must be there, once.
	source := string(asset(Page))
	tags := append(
		[]string{titleTag, brandTag, descriptionTag, ogTitleTag, styleTag, scriptTag, `content="` + policyOfFiles + `"`},
		preloadTags...,
	)
	for _, tag := range tags {
		if strings.Count(source, tag) != 1 {
			t.Errorf("the embedded page has %d of %s, want 1", strings.Count(source, tag), tag)
		}
	}
}

func TestAssetPanicsOnABrokenBuild(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("a missing asset did not panic")
		}
	}()
	asset("no-such-file")
}

func TestWrite(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "a", "site")
	files := map[string][]byte{"index.html": []byte("page"), "core.wasm": {0, 1, 2}, "fonts/a.woff2": []byte("font")}
	if err := Write(dir, files); err != nil {
		t.Fatal(err)
	}
	for name, want := range files {
		got, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil || !bytes.Equal(got, want) {
			t.Errorf("%s = %q, %v", name, got, err)
		}
	}

	// The directory cannot be made: its parent is a file.
	blocker := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(blocker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Write(filepath.Join(blocker, "site"), files); err == nil {
		t.Error("Write under a file succeeded")
	}
	// A directory in it cannot be made: its name is a file.
	crowded := t.TempDir()
	if err := os.WriteFile(filepath.Join(crowded, "fonts"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Write(crowded, map[string][]byte{"fonts/a.woff2": []byte("font")}); err == nil {
		t.Error("Write into a file succeeded")
	}
	// A file cannot be written: its name is a directory.
	taken := t.TempDir()
	if err := os.Mkdir(filepath.Join(taken, "index.html"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := Write(taken, map[string][]byte{"index.html": []byte("page")}); err == nil {
		t.Error("Write over a directory succeeded")
	}
}

func TestNothingIsWrittenThroughALink(t *testing.T) {
	outside := filepath.Join(t.TempDir(), "authorized_keys")
	if err := os.WriteFile(outside, []byte("mine"), 0o600); err != nil {
		t.Fatal(err)
	}

	// A file of the site that is a link to somewhere else, as a hostile
	// repository could commit it.
	dir := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(dir, "schema.binpb")); err != nil {
		t.Fatal(err)
	}
	if err := Write(dir, map[string][]byte{"schema.binpb": []byte("the schema")}); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(outside); string(got) != "mine" {
		t.Errorf("the file the link pointed at now holds %q", got)
	}
	info, err := os.Lstat(filepath.Join(dir, "schema.binpb"))
	if err != nil || info.Mode()&os.ModeSymlink != 0 {
		t.Errorf("the link is still a link: %v", info.Mode())
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "schema.binpb")); string(got) != "the schema" {
		t.Errorf("the site's file holds %q", got)
	}
	if info.Mode().Perm() != 0o644 {
		t.Errorf("mode = %v, want 0644", info.Mode().Perm())
	}

	// The directory itself as a link.
	elsewhere := t.TempDir()
	link := filepath.Join(t.TempDir(), "site")
	if err := os.Symlink(elsewhere, link); err != nil {
		t.Fatal(err)
	}
	err = Write(link, map[string][]byte{"index.html": []byte("page")})
	if err == nil || !strings.Contains(err.Error(), "is a symbolic link") {
		t.Errorf("Write into a linked directory: %v", err)
	}
	if entries, _ := os.ReadDir(elsewhere); len(entries) != 0 {
		t.Errorf("files were written where the link pointed: %v", entries)
	}

	// A directory inside the site as a link: the fonts would land elsewhere.
	site := t.TempDir()
	if err := os.Symlink(elsewhere, filepath.Join(site, "fonts")); err != nil {
		t.Fatal(err)
	}
	err = Write(site, map[string][]byte{"fonts/a.woff2": []byte("font")})
	if err == nil || !strings.Contains(err.Error(), "is a symbolic link") {
		t.Errorf("Write into a linked directory of the site: %v", err)
	}
	if entries, _ := os.ReadDir(elsewhere); len(entries) != 0 {
		t.Errorf("files were written where the link pointed: %v", entries)
	}
}

func TestWriteFileLeavesNothingBehind(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "index.html")

	// Something already has the temporary name: a link, even. It is not
	// written to, and the write fails.
	outside := filepath.Join(t.TempDir(), "target")
	if err := os.Symlink(outside, temporary(path)); err != nil {
		t.Fatal(err)
	}
	if err := WriteFile(path, []byte("page")); err == nil {
		t.Error("WriteFile used a temporary name that was taken")
	}
	if _, err := os.Stat(outside); err == nil {
		t.Error("WriteFile wrote through the link at its temporary name")
	}
	if err := os.Remove(temporary(path)); err != nil {
		t.Fatal(err)
	}

	// The target is a directory: the rename fails, and the temporary file goes.
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := WriteFile(path, []byte("page")); err == nil {
		t.Error("WriteFile replaced a directory")
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Errorf("left behind: %v", entries)
	}
}
