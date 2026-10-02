package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseFillsDefaults(t *testing.T) {
	file, err := Parse(strings.NewReader(`{
		"environments": [{"name": " local ", "baseUrl": " http://localhost:8080 "}, {"name": "proxy", "baseUrl": "/api"}],
		"auth": [{"scheme": "bearer"}, {"scheme": "basic"}, {"scheme": "api-key"}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if file.Title != DefaultTitle {
		t.Errorf("title = %q, want the default", file.Title)
	}
	if got := file.Environments[0]; got.Name != "local" || got.BaseURL != "http://localhost:8080" {
		t.Errorf("environment not trimmed: %+v", got)
	}
	if got := file.Auth[2]; got.Name != "X-API-Key" || got.Location != "header" {
		t.Errorf("api-key defaults = %+v", got)
	}
}

func TestParseKeepsWhatIsSet(t *testing.T) {
	file, err := Parse(strings.NewReader(`{"title": "Widgets", "auth": [{"scheme": "api-key", "name": "key", "location": "query"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if file.Title != "Widgets" || file.Auth[0].Name != "key" || file.Auth[0].Location != "query" {
		t.Errorf("file = %+v", file)
	}
}

func TestParseRefuses(t *testing.T) {
	cases := map[string]string{
		`{`:                   "parse config:",
		`{} {}`:               "more than one JSON value",
		`{"token": "s3cr3t"}`: `unknown field "token"`,
		`{"auth": [{"scheme": "bearer", "token": "s3cr3t"}]}`:                                 `unknown field "token"`,
		`{"auth": [{"scheme": "basic", "password": "p"}]}`:                                    `unknown field "password"`,
		`{"environments": [{"baseUrl": "/"}]}`:                                                "environment 1 has no name",
		`{"environments": [{"name": "a", "baseUrl": "/"}, {"name": "a", "baseUrl": "/"}]}`:    `two environments are named "a"`,
		`{"environments": [{"name": "a", "baseUrl": "localhost"}]}`:                           `environment "a": baseUrl must start with http://, https:// or a single /`,
		`{"environments": [{"name": "a", "baseUrl": "https://user:s3cr3t@api.example.com"}]}`: "baseUrl must not carry a user name or a password",
		`{"environments": [{"name": "a", "baseUrl": "https://api.example.com/?key=s3cr3t"}]}`: "baseUrl must not have spaces, a backslash, a query or a fragment",
		`{"environments": [{"name": "a", "baseUrl": "/", "directUrl": "http://x"}]}`:          "directUrl is set by",
		`{"auth": [{"scheme": "bearer"}, {"scheme": "bearer"}]}`:                              `"bearer" is listed twice`,
		`{"auth": [{"scheme": "bearer", "name": "X"}]}`:                                       "takes no name and no location",
		`{"auth": [{"scheme": "basic", "location": "query"}]}`:                                "takes no name and no location",
		`{"auth": [{"scheme": "api-key", "name": "two words"}]}`:                              "is not a header or parameter name",
		`{"auth": [{"scheme": "api-key", "location": "cookie"}]}`:                             `location is "cookie"`,
		`{"auth": [{"scheme": "oauth2"}]}`:                                                    `scheme is "oauth2"`,
		`{"auth": [{"scheme": "none"}]}`:                                                      `scheme is "none"`,
	}
	for input, want := range cases {
		_, err := Parse(strings.NewReader(input))
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("Parse(%s) = %v, want an error with %q", input, err, want)
		}
	}
}

func TestToken(t *testing.T) {
	for name, want := range map[string]bool{"X-API-Key": true, "key_1": true, "a.b~c": true, "": false, "a b": false, "a:b": false, "é": false} {
		if got := token(name); got != want {
			t.Errorf("token(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestLoad(t *testing.T) {
	file, err := Load("")
	if err != nil || file.Title != DefaultTitle {
		t.Fatalf("Load(\"\") = %+v, %v", file, err)
	}

	dir := t.TempDir()
	good := filepath.Join(dir, "wirebook.json")
	if err := os.WriteFile(good, []byte(`{"title": "T"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if file, err := Load(good); err != nil || file.Title != "T" {
		t.Errorf("Load(good) = %+v, %v", file, err)
	}

	bad := filepath.Join(dir, "bad.json")
	if err := os.WriteFile(bad, []byte(`{"nope": 1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(bad); err == nil || !strings.Contains(err.Error(), "bad.json") {
		t.Errorf("Load(bad) = %v, want an error that names the file", err)
	}
	if _, err := Load(filepath.Join(dir, "missing.json")); err == nil {
		t.Error("Load(missing) = nil, want an error")
	}
}

func TestSite(t *testing.T) {
	file, err := Parse(strings.NewReader(`{
		"title": "Widgets",
		"environments": [{"name": "local", "baseUrl": "http://localhost:8080"}],
		"auth": [{"scheme": "bearer"}, {"scheme": "basic"}, {"scheme": "api-key", "name": "key", "location": "query"}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	got := file.Site("abc123", []string{"a.proto"}, true).JSON()
	want := `{"id":"abc123","title":"Widgets","roots":["a.proto"],"environments":[{"name":"local","baseUrl":"http://localhost:8080"}],` +
		`"auth":[{"scheme":"bearer"},{"scheme":"basic","username":""},{"scheme":"api-key","name":"key","location":"query"}],"lookups":{},"liveReload":true}`
	if string(got) != want {
		t.Errorf("site =\n%s\nwant\n%s", got, want)
	}

	// Nothing configured: lists, not nulls.
	empty := File{Title: DefaultTitle}.Site("", nil, false).JSON()
	if want := `{"id":"","title":"API explorer","roots":[],"environments":[],"auth":[],"lookups":{},"liveReload":false}`; string(empty) != want {
		t.Errorf("empty site = %s, want %s", empty, want)
	}
}

func TestDiscover(t *testing.T) {
	dir := t.TempDir()
	if got := Discover(dir); got != "" {
		t.Errorf("Discover(empty dir) = %q", got)
	}
	// A directory of that name is not a config.
	if err := os.Mkdir(filepath.Join(dir, FileName), 0o700); err != nil {
		t.Fatal(err)
	}
	if got := Discover(dir); got != "" {
		t.Errorf("Discover(dir with a directory) = %q", got)
	}
	other := t.TempDir()
	want := filepath.Join(other, FileName)
	if err := os.WriteFile(want, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := Discover(other); got != want {
		t.Errorf("Discover = %q, want %q", got, want)
	}
}

func TestCheckBaseURL(t *testing.T) {
	for _, url := range []string{"http://localhost:8080", "https://api.example.com/v1", "/", "/proxy", "https://h/a@b"} {
		if err := CheckBaseURL(url); err != nil {
			t.Errorf("CheckBaseURL(%q) = %v, want nil", url, err)
		}
	}
	cases := map[string]string{
		"":                                    "must start with",
		"api.example.com":                     "must start with",
		"ftp://x":                             "must start with",
		"//evil.example":                      "must start with",
		`/\evil.example`:                      "backslash",
		`http://good.example\@evil.example`:   "backslash",
		"https://api.example.com/?key=s3cr3t": "query",
		"https://api.example.com/#x":          "fragment",
		"http://a b":                          "spaces",
		"http://a\x07":                        "spaces",
		"http://":                             "has no host",
		"https:///path":                       "has no host",
		"https://user:s3cr3t@api.example.com": "must not carry a user name or a password",
		"https://token@api.example.com/x":     "must not carry a user name or a password",
	}
	for url, want := range cases {
		if err := CheckBaseURL(url); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("CheckBaseURL(%q) = %v, want an error with %q", url, err, want)
		}
	}
}

func TestVariablesAndLookups(t *testing.T) {
	file, err := Parse(strings.NewReader(`{
		"environments": [{"name": "local", "baseUrl": "/", "variables": {"rackId": "r-1", "_n": "7"}}],
		"lookups": {"acme.v1.Thing.owner_id": "acme.v1.Owners/ListOwners", "acme.v1.Thing.part_id": null}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	got := string(file.Site("id", nil, false).JSON())
	for _, want := range []string{
		`"variables":{"_n":"7","rackId":"r-1"}`,
		`"lookups":{"acme.v1.Thing.owner_id":"acme.v1.Owners/ListOwners","acme.v1.Thing.part_id":null}`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("config.json lacks %s:\n%s", want, got)
		}
	}

	refused := map[string]string{
		`{"environments": [{"name": "a", "baseUrl": "/", "variables": {"rack-id": "x"}}]}`:  `the variable name "rack-id" is not a name`,
		`{"environments": [{"name": "a", "baseUrl": "/", "variables": {"9lives": "x"}}]}`:   `the variable name "9lives" is not a name`,
		`{"environments": [{"name": "a", "baseUrl": "/", "variables": {"": "x"}}]}`:         `the variable name "" is not a name`,
		`{"environments": [{"name": "a", "baseUrl": "/", "variables": {"apiToken": "x"}}]}`: `the variable "apiToken" is named like a credential`,
		`{"environments": [{"name": "a", "baseUrl": "/", "variables": {"PASSWORD": "x"}}]}`: `the variable "PASSWORD" is named like a credential`,
		`{"environments": [{"name": "a", "baseUrl": "/", "variables": {"n": 5}}]}`:          "parse config:",
	}
	for input, want := range refused {
		if _, err := Parse(strings.NewReader(input)); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("Parse(%s) = %v, want an error with %q", input, err, want)
		}
	}
}
