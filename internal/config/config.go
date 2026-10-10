// Package config reads wirebook.json, the settings a repository gives its
// explorer: a title, the environments an API runs in, and the authentication
// schemes it accepts.
//
// The file is committed and the site is public, so it has no field that
// could hold a secret, and an unknown field is an error: a token typed into
// it is refused, not published.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"
)

// DefaultTitle names a site whose config gives none.
const DefaultTitle = "API explorer"

// File is the content of wirebook.json.
type File struct {
	Title        string        `json:"title"`
	Environments []Environment `json:"environments"`
	Auth         []Auth        `json:"auth"`
	// Lookups names the list a field's value is picked from, where the
	// naming convention finds none: "package.Message.field" to
	// "package.Service/Method", or to null for no list. The page checks that
	// the method may be called on its own.
	Lookups map[string]*string `json:"lookups,omitempty"`
	// Links are shown in the page's footer, beside the link to wirebook:
	// the API's own documentation, its repository, where to ask.
	Links []Link `json:"links,omitempty"`
}

// Link is a place the footer points at. The file is published, so the URL
// is https only, and never carries a credential.
type Link struct {
	Label string `json:"label"`
	URL   string `json:"url"`
}

// Environment is a place the API runs.
type Environment struct {
	Name string `json:"name"`
	// BaseURL is an origin, with or without a path prefix, or a path on the
	// site's own origin.
	BaseURL string `json:"baseUrl"`
	// DirectURL is where the API really is when BaseURL is a proxy. A copied
	// curl command goes there. `wirebook serve` sets it; the file may not.
	DirectURL string `json:"directUrl,omitempty"`
	// Variables are values several requests share, written {{name}} in a
	// body or a header. They are published with the site: not for secrets.
	Variables map[string]string `json:"variables,omitempty"`
}

// Auth is a scheme the API accepts, without a credential.
type Auth struct {
	// Scheme is "bearer", "basic" or "api-key".
	Scheme string `json:"scheme"`
	// Name is the header or the query parameter of an API key.
	Name string `json:"name,omitempty"`
	// Location is "header" or "query", for an API key.
	Location string `json:"location,omitempty"`
}

// Site is config.json, as the page reads it.
type Site struct {
	// ID names the API, so the page keeps its store apart from another's.
	ID           string             `json:"id"`
	Title        string             `json:"title"`
	Roots        []string           `json:"roots"`
	Environments []Environment      `json:"environments"`
	Auth         []Setting          `json:"auth"`
	Lookups      map[string]*string `json:"lookups"`
	Links        []Link             `json:"links"`
	LiveReload   bool               `json:"liveReload"`
}

// Setting is a scheme as the page offers it: what an environment starts
// with, before anyone types a credential.
type Setting struct {
	Scheme string `json:"scheme"`
	// Username is set, and empty, for basic: the page asks for it.
	Username *string `json:"username,omitempty"`
	Name     string  `json:"name,omitempty"`
	Location string  `json:"location,omitempty"`
}

// JSON is the content of config.json. A Site is text, flags and lists of
// them: encoding it cannot fail. The encoder escapes <, > and &, so the
// result can also sit inside a script element of a page.
func (s Site) JSON() []byte {
	data, _ := json.Marshal(s)
	return data
}

// FileName is the config a command looks for when it is given none.
const FileName = "wirebook.json"

// Discover returns the path of the config in dir, or "" when dir has none.
func Discover(dir string) string {
	path := filepath.Join(dir, FileName)
	if info, err := os.Stat(path); err != nil || info.IsDir() {
		return ""
	}
	return path
}

// Load reads the file at path. A path of "" is no file: the defaults.
func Load(path string) (File, error) {
	if path == "" {
		return File{Title: DefaultTitle}, nil
	}
	f, err := os.Open(path) //nolint:gosec // G304: the path is the --config flag; opening it is the command's job.
	if err != nil {
		return File{}, err
	}
	defer f.Close() //nolint:errcheck // Read only: a failed close loses nothing.
	file, err := Parse(f)
	if err != nil {
		return File{}, fmt.Errorf("%s: %w", path, err)
	}
	return file, nil
}

// Parse reads and checks a config. It fills the defaults in.
func Parse(r io.Reader) (File, error) {
	var file File
	dec := json.NewDecoder(r)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&file); err != nil {
		return File{}, fmt.Errorf("parse config: %w", err)
	}
	if dec.More() {
		return File{}, errors.New("parse config: more than one JSON value")
	}
	if strings.TrimSpace(file.Title) == "" {
		file.Title = DefaultTitle
	}

	names := map[string]bool{}
	for i := range file.Environments {
		env := &file.Environments[i]
		env.Name = strings.TrimSpace(env.Name)
		env.BaseURL = strings.TrimSpace(env.BaseURL)
		switch {
		case env.Name == "":
			return File{}, fmt.Errorf("environment %d has no name", i+1)
		case names[env.Name]:
			return File{}, fmt.Errorf("two environments are named %q", env.Name)
		case env.DirectURL != "":
			return File{}, fmt.Errorf("environment %q: directUrl is set by `wirebook serve`, not in the file", env.Name)
		}
		if err := CheckBaseURL(env.BaseURL); err != nil {
			return File{}, fmt.Errorf("environment %q: baseUrl %w", env.Name, err)
		}
		for name := range env.Variables {
			if !identifier(name) {
				return File{}, fmt.Errorf("environment %q: the variable name %q is not a name: letters, digits and _", env.Name, name)
			}
			if credentialName(name) {
				return File{}, fmt.Errorf("environment %q: the variable %q is named like a credential, and this file is published", env.Name, name)
			}
		}
		names[env.Name] = true
	}

	schemes := map[string]bool{}
	for i := range file.Auth {
		auth := &file.Auth[i]
		if schemes[auth.Scheme] {
			return File{}, fmt.Errorf("the auth scheme %q is listed twice", auth.Scheme)
		}
		schemes[auth.Scheme] = true
		switch auth.Scheme {
		case "bearer", "basic":
			if auth.Name != "" || auth.Location != "" {
				return File{}, fmt.Errorf("the auth scheme %q takes no name and no location", auth.Scheme)
			}
		case "api-key":
			if auth.Name == "" {
				auth.Name = "X-API-Key"
			}
			if auth.Location == "" {
				auth.Location = "header"
			}
			if !token(auth.Name) {
				return File{}, fmt.Errorf("the API key name %q is not a header or parameter name", auth.Name)
			}
			if auth.Location != "header" && auth.Location != "query" {
				return File{}, fmt.Errorf("the API key location is %q, want header or query", auth.Location)
			}
		default:
			return File{}, fmt.Errorf("the auth scheme is %q, want bearer, basic or api-key", auth.Scheme)
		}
	}

	if len(file.Links) > maxLinks {
		return File{}, fmt.Errorf("%d links, the footer holds %d", len(file.Links), maxLinks)
	}
	urls := map[string]bool{}
	for i := range file.Links {
		link := &file.Links[i]
		link.Label = strings.TrimSpace(link.Label)
		link.URL = strings.TrimSpace(link.URL)
		switch {
		case link.Label == "":
			return File{}, fmt.Errorf("link %d has no label", i+1)
		case utf8.RuneCountInString(link.Label) > maxLabel:
			return File{}, fmt.Errorf("link %d: the label is longer than %d characters", i+1, maxLabel)
		case urls[link.URL]:
			return File{}, fmt.Errorf("link %d: %s is listed twice", i+1, link.URL)
		}
		if err := CheckLinkURL(link.URL); err != nil {
			return File{}, fmt.Errorf("link %q: url %w", link.Label, err)
		}
		urls[link.URL] = true
	}
	return file, nil
}

// The footer is one line of links.
const (
	maxLinks = 8
	maxLabel = 60
)

// CheckLinkURL holds a footer link to the rules of a published file: https,
// a host, no credential, no whitespace or control character. A query or a
// fragment is allowed: a page of documentation has an anchor.
func CheckLinkURL(url string) error {
	rest, ok := strings.CutPrefix(url, "https://")
	if !ok {
		return errors.New("must start with https://")
	}
	if strings.ContainsFunc(url, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) || r == '\\' }) {
		return errors.New("must not have spaces, a backslash or a control character")
	}
	host := rest
	if i := strings.IndexAny(rest, "/?#"); i >= 0 {
		host = rest[:i]
	}
	if host == "" {
		return errors.New("has no host")
	}
	if strings.Contains(host, "@") {
		return errors.New("must not carry a user name or a password")
	}
	return nil
}

// CheckBaseURL holds a base URL to the rules the page's core has: an origin
// with or without a path, or one slash and a path on the site's own origin.
//
// The file is published with the site, so a URL in it must not carry a
// credential: no user name, no password, no query. And it must be what it
// looks like: "//host" and "/\host" are another origin to a browser.
func CheckBaseURL(url string) error {
	authority, remote := strings.CutPrefix(url, "https://")
	if !remote {
		authority, remote = strings.CutPrefix(url, "http://")
	}
	local := strings.HasPrefix(url, "/") && !strings.HasPrefix(url, "//")
	if !remote && !local {
		return errors.New("must start with http://, https:// or a single /")
	}
	if strings.ContainsFunc(url, func(r rune) bool {
		return unicode.IsSpace(r) || unicode.IsControl(r) || r == '?' || r == '#' || r == '\\'
	}) {
		return errors.New("must not have spaces, a backslash, a query or a fragment")
	}
	if remote {
		host, _, _ := strings.Cut(authority, "/")
		if host == "" {
			return errors.New("has no host")
		}
		if strings.Contains(host, "@") {
			return errors.New("must not carry a user name or a password")
		}
	}
	return nil
}

// identifier reports whether name can be written {{name}}.
func identifier(name string) bool {
	for i, c := range []byte(name) {
		letter := c == '_' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
		if !letter && (i == 0 || c < '0' || c > '9') {
			return false
		}
	}
	return name != ""
}

// credentialName reports whether a name says its value is a secret. The
// page refuses such a name too, for a header and for a variable.
func credentialName(name string) bool {
	lower := strings.ToLower(name)
	for _, word := range []string{"token", "secret", "passw", "credential", "apikey", "api_key", "cookie", "auth"} {
		if strings.Contains(lower, word) {
			return true
		}
	}
	return false
}

// token reports whether name is an HTTP token (RFC 9110), which is what a
// header name is made of.
func token(name string) bool {
	if name == "" {
		return false
	}
	for _, c := range []byte(name) {
		alnum := c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
		if !alnum && !strings.ContainsRune("!#$%&'*+-.^_`|~", rune(c)) {
			return false
		}
	}
	return true
}

// Site makes config.json from the file and the files the site documents.
func (f File) Site(id string, roots []string, liveReload bool) Site {
	site := Site{
		ID:           id,
		Title:        f.Title,
		Roots:        roots,
		Environments: f.Environments,
		Auth:         []Setting{},
		Lookups:      f.Lookups,
		Links:        f.Links,
		LiveReload:   liveReload,
	}
	// The page reads a nil slice as null; it wants a list.
	if site.Roots == nil {
		site.Roots = []string{}
	}
	if site.Environments == nil {
		site.Environments = []Environment{}
	}
	if site.Lookups == nil {
		site.Lookups = map[string]*string{}
	}
	if site.Links == nil {
		site.Links = []Link{}
	}
	for _, auth := range f.Auth {
		setting := Setting{Scheme: auth.Scheme, Name: auth.Name, Location: auth.Location}
		if auth.Scheme == "basic" {
			setting.Username = new(string)
		}
		site.Auth = append(site.Auth, setting)
	}
	return site
}
