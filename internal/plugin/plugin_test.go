package plugin

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/iotest"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/descriptorpb"
	"google.golang.org/protobuf/types/pluginpb"
)

// request is what buf hands the plugin for the fixture protos.
func request(t *testing.T, parameter string) *pluginpb.CodeGeneratorRequest {
	t.Helper()
	data, err := os.ReadFile("../../testdata/fixture.binpb")
	if err != nil {
		t.Fatal(err)
	}
	var set descriptorpb.FileDescriptorSet
	if err := proto.Unmarshal(data, &set); err != nil {
		t.Fatal(err)
	}
	return &pluginpb.CodeGeneratorRequest{
		FileToGenerate: []string{"fixture/v1/editions.proto", "fixture/v1/library.proto"},
		ProtoFile:      set.GetFile(),
		Parameter:      proto.String(parameter),
	}
}

func TestGenerateWritesOnePage(t *testing.T) {
	response := Generate(request(t, ""))
	if response.Error != nil {
		t.Fatal(response.GetError())
	}
	features := response.GetSupportedFeatures()
	if features&uint64(pluginpb.CodeGeneratorResponse_FEATURE_SUPPORTS_EDITIONS) == 0 ||
		features&uint64(pluginpb.CodeGeneratorResponse_FEATURE_PROTO3_OPTIONAL) == 0 {
		t.Errorf("features = %b: editions and proto3 optional must both be declared", features)
	}
	if response.GetMaximumEdition() != int32(descriptorpb.Edition_EDITION_2024) || response.GetMinimumEdition() != int32(descriptorpb.Edition_EDITION_PROTO2) {
		t.Errorf("editions = %d to %d", response.GetMinimumEdition(), response.GetMaximumEdition())
	}
	if len(response.GetFile()) != 1 || response.GetFile()[0].GetName() != "index.html" {
		t.Fatalf("files = %v", response.GetFile())
	}
	page := response.GetFile()[0].GetContent()
	for _, want := range []string{
		"<title>API explorer</title>",
		`"roots":["fixture/v1/editions.proto","fixture/v1/library.proto"]`,
		`id="wirebook-schema"`,
		`id="wirebook-core"`,
	} {
		if !strings.Contains(page, want) {
			t.Errorf("the page lacks %s", want)
		}
	}
}

func TestOptions(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "explorer.json")
	if err := os.WriteFile(path, []byte(`{"title": "From the file", "auth": [{"scheme": "bearer"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}

	response := Generate(request(t, "config="+path+",out=docs/api.html"))
	if response.Error != nil {
		t.Fatal(response.GetError())
	}
	file := response.GetFile()[0]
	if file.GetName() != "docs/api.html" {
		t.Errorf("name = %q", file.GetName())
	}
	if !strings.Contains(file.GetContent(), "<title>From the file</title>") || !strings.Contains(file.GetContent(), `"auth":[{"scheme":"bearer"}]`) {
		t.Error("the config file was not used")
	}

	// The title option wins over the file; an empty part is skipped.
	response = Generate(request(t, "config="+path+",,title=From the option"))
	if !strings.Contains(response.GetFile()[0].GetContent(), "<title>From the option</title>") {
		t.Error("the title option was not used")
	}
}

func TestTheConfigOfTheModuleIsFound(t *testing.T) {
	// The fixture is read before the test moves to another directory.
	fixture := request(t, "")
	t.Chdir(t.TempDir())
	if err := os.WriteFile("wirebook.json", []byte(`{"title": "Found"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	response := Generate(fixture)
	if response.Error != nil || !strings.Contains(response.GetFile()[0].GetContent(), "<title>Found</title>") {
		t.Errorf("the config in the working directory was not used: %q", response.GetError())
	}
}

func TestARequestThatCannotBeHonouredSaysWhy(t *testing.T) {
	cases := map[string]string{
		"colour=blue":               `wirebook: unknown option "colour": the options are config, out and title`,
		"out=":                      `wirebook: the option out needs a file name inside the output directory; got ""`,
		"out=../../etc/x.html":      `wirebook: the option out needs a file name inside the output directory; got "../../etc/x.html"`,
		"out=/tmp/x.html":           `wirebook: the option out needs a file name inside the output directory; got "/tmp/x.html"`,
		`out=a\..\..\x.html`:        "wirebook: the option out needs a file name inside the output directory",
		"config=/no/such/file.json": "wirebook: open /no/such/file.json",
	}
	for parameter, want := range cases {
		response := Generate(request(t, parameter))
		if !strings.HasPrefix(response.GetError(), want) || len(response.GetFile()) != 0 {
			t.Errorf("%s: error = %q, files = %d", parameter, response.GetError(), len(response.GetFile()))
		}
		// The features are declared even then: protoc reads them first.
		if response.GetSupportedFeatures() == 0 {
			t.Errorf("%s: no features on an error response", parameter)
		}
	}

	nothing := &pluginpb.CodeGeneratorRequest{}
	if got := Generate(nothing).GetError(); got != "wirebook: the request names no file to generate" {
		t.Errorf("error = %q", got)
	}
}

func TestRun(t *testing.T) {
	encoded, err := proto.Marshal(request(t, "title=Run"))
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := Run(bytes.NewReader(encoded), &out); err != nil {
		t.Fatal(err)
	}
	var response pluginpb.CodeGeneratorResponse
	if err := proto.Unmarshal(out.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Error != nil || !strings.Contains(response.GetFile()[0].GetContent(), "<title>Run</title>") {
		t.Errorf("response error = %q", response.GetError())
	}

	if err := Run(iotest.ErrReader(errors.New("pipe closed")), &out); err == nil || !strings.Contains(err.Error(), "read the request") {
		t.Errorf("err = %v", err)
	}
	if err := Run(bytes.NewReader([]byte{0xff}), &out); err == nil || !strings.Contains(err.Error(), "not a CodeGeneratorRequest") {
		t.Errorf("err = %v", err)
	}
	if err := Run(bytes.NewReader(encoded), failingWriter{}); err == nil || !strings.Contains(err.Error(), "write the response") {
		t.Errorf("err = %v", err)
	}
}

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) { return 0, errors.New("disk full") }
