package image

import (
	"os"
	"slices"
	"strings"
	"testing"

	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/descriptorpb"
	"google.golang.org/protobuf/types/pluginpb"
)

var fixtureRoots = []string{
	"fixture/legacy/v1/proto2.proto",
	"fixture/legacy/v1/proto3.proto",
	"fixture/v1/editions.proto",
	"fixture/v1/library.proto",
}

func fixture(t *testing.T) []byte {
	t.Helper()
	data, err := os.ReadFile("../../testdata/fixture.binpb")
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func set(t *testing.T, files ...*descriptorpb.FileDescriptorProto) []byte {
	t.Helper()
	data, err := proto.Marshal(&descriptorpb.FileDescriptorSet{File: files})
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func file(name string) *descriptorpb.FileDescriptorProto {
	return &descriptorpb.FileDescriptorProto{Name: proto.String(name)}
}

// marked is a file with the Buf extension, as `buf build` writes it.
func marked(name string, imported bool) *descriptorpb.FileDescriptorProto {
	f := file(name)
	var extension []byte
	// A field before is_import, to be skipped.
	extension = protowire.AppendTag(extension, 3, protowire.VarintType)
	extension = protowire.AppendVarint(extension, 1)
	if imported {
		extension = protowire.AppendTag(extension, isImport, protowire.VarintType)
		extension = protowire.AppendVarint(extension, 1)
	}
	var unknown []byte
	// An unknown field that is not the extension, to be skipped.
	unknown = protowire.AppendTag(unknown, 9000, protowire.VarintType)
	unknown = protowire.AppendVarint(unknown, 7)
	unknown = protowire.AppendTag(unknown, bufExtension, protowire.BytesType)
	unknown = protowire.AppendBytes(unknown, extension)
	f.ProtoReflect().SetUnknown(unknown)
	return f
}

func TestFromBytesReadsTheMarksOfABufImage(t *testing.T) {
	data := fixture(t)
	img, err := FromBytes(data)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(img.Roots, fixtureRoots) {
		t.Errorf("roots = %v, want %v", img.Roots, fixtureRoots)
	}
	if &img.Bytes[0] != &data[0] {
		t.Error("the bytes were copied; the page must get the set as it was built")
	}
}

func TestFromBytesTrustsTheMarksOverTheNames(t *testing.T) {
	// A Buf image says which file is an import, whatever it is called.
	img, err := FromBytes(set(t, marked("google/api/mine.proto", false), marked("vendor/theirs.proto", true)))
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"google/api/mine.proto"}; !slices.Equal(img.Roots, want) {
		t.Errorf("roots = %v, want %v", img.Roots, want)
	}
}

func TestFromBytesGuessesForAPlainSet(t *testing.T) {
	img, err := FromBytes(set(t,
		file("google/protobuf/timestamp.proto"),
		file("google/api/http.proto"),
		file("google/rpc/status.proto"),
		file("google/type/date.proto"),
		file("buf/validate/validate.proto"),
		file("acme/v1/a.proto"),
		file("googleish/b.proto"),
	))
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"acme/v1/a.proto", "googleish/b.proto"}; !slices.Equal(img.Roots, want) {
		t.Errorf("roots = %v, want %v", img.Roots, want)
	}
}

func TestFromBytesRefuses(t *testing.T) {
	cases := []struct {
		name string
		data []byte
		want string
	}{
		{"not a set", []byte{0xff, 0xff}, "the descriptor set is not valid"},
		{"empty", nil, "the descriptor set has no files"},
		{"only imports, marked", set(t, marked("a.proto", true)), "every file of the descriptor set is an import"},
		{"only imports, guessed", set(t, file("google/protobuf/any.proto")), "every file of the descriptor set is an import"},
	}
	for _, c := range cases {
		if _, err := FromBytes(c.data); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: err = %v, want %q", c.name, err, c.want)
		}
	}
}

func TestBufImportSurvivesMalformedUnknownFields(t *testing.T) {
	extension := protowire.AppendBytes(protowire.AppendTag(nil, bufExtension, protowire.BytesType), []byte{0x08, 0x01})
	cases := []struct {
		name             string
		unknown          []byte
		imported, marked bool
	}{
		{"nothing", nil, false, false},
		{"a tag cut short", []byte{0x80}, false, false},
		{"a value cut short", protowire.AppendTag(nil, 5, protowire.Fixed64Type), false, false},
		{"the extension cut short", append(protowire.AppendTag(nil, bufExtension, protowire.BytesType), 0x05, 0x01), false, false},
		{"the extension as a varint", protowire.AppendVarint(protowire.AppendTag(nil, bufExtension, protowire.VarintType), 1), false, false},
		{"marked, then cut short", append(slices.Clone(extension), 0x80), false, true},
		{"marked", extension, true, true},
	}
	for _, c := range cases {
		imported, marked := bufImport(c.unknown)
		if imported != c.imported || marked != c.marked {
			t.Errorf("%s: bufImport = %v, %v, want %v, %v", c.name, imported, marked, c.imported, c.marked)
		}
	}
}

func TestFlag(t *testing.T) {
	cases := []struct {
		name    string
		message []byte
		want    bool
	}{
		{"empty", nil, false},
		{"set", []byte{0x08, 0x01}, true},
		{"zero", []byte{0x08, 0x00}, false},
		{"a tag cut short", []byte{0x80}, false},
		{"the value cut short", []byte{0x08, 0x80}, false},
		{"another field cut short", []byte{0x11, 0x00}, false},
		{"the field with another type", []byte{0x0a, 0x00}, false},
	}
	for _, c := range cases {
		if got := flag(c.message, isImport); got != c.want {
			t.Errorf("%s: flag = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestFromRequest(t *testing.T) {
	request := &pluginpb.CodeGeneratorRequest{
		FileToGenerate: []string{"acme/v1/a.proto"},
		ProtoFile:      []*descriptorpb.FileDescriptorProto{file("google/protobuf/any.proto"), file("acme/v1/a.proto")},
	}
	img, err := FromRequest(request)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"acme/v1/a.proto"}; !slices.Equal(img.Roots, want) {
		t.Errorf("roots = %v, want %v", img.Roots, want)
	}
	var got descriptorpb.FileDescriptorSet
	if err := proto.Unmarshal(img.Bytes, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.GetFile()) != 2 || got.GetFile()[1].GetName() != "acme/v1/a.proto" {
		t.Errorf("the set lost its files: %v", got.GetFile())
	}

	if _, err := FromRequest(&pluginpb.CodeGeneratorRequest{}); err == nil {
		t.Error("a request with no file to generate was accepted")
	}
	// A message with a required field unset cannot be encoded.
	broken := file("a.proto")
	broken.Options = &descriptorpb.FileOptions{UninterpretedOption: []*descriptorpb.UninterpretedOption{
		{Name: []*descriptorpb.UninterpretedOption_NamePart{{}}},
	}}
	bad := &pluginpb.CodeGeneratorRequest{
		FileToGenerate: []string{"a.proto"},
		ProtoFile:      []*descriptorpb.FileDescriptorProto{broken},
	}
	if _, err := FromRequest(bad); err == nil || !strings.Contains(err.Error(), "encode the descriptor set") {
		t.Errorf("err = %v, want an encoding error", err)
	}
}

func TestTheIDFollowsThePackagesNotTheFiles(t *testing.T) {
	img, err := FromBytes(fixture(t))
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"fixture.legacy.v1", "fixture.v1"}; !slices.Equal(img.Packages, want) {
		t.Errorf("packages = %v, want %v", img.Packages, want)
	}
	id := img.ID()
	if len(id) != 16 || strings.Trim(id, "0123456789abcdef") != "" {
		t.Errorf("id = %q, want 16 hex digits", id)
	}

	pkg := func(name, pkg string) *descriptorpb.FileDescriptorProto {
		f := file(name)
		f.Package = proto.String(pkg)
		return f
	}
	one, _ := FromBytes(set(t, pkg("a/x.proto", "a"), pkg("b/y.proto", "b")))
	// Another file of the same packages, in another order: the same API.
	two, _ := FromBytes(set(t, pkg("b/y.proto", "b"), pkg("a/z.proto", "a"), pkg("a/x.proto", "a")))
	other, _ := FromBytes(set(t, pkg("a/x.proto", "a"), pkg("c/y.proto", "c")))
	if one.ID() != two.ID() {
		t.Errorf("the same packages gave %s and %s", one.ID(), two.ID())
	}
	if one.ID() == other.ID() || one.ID() == id {
		t.Error("other packages gave the same id")
	}
	// An import's package is not part of it.
	withImport, _ := FromBytes(set(t, pkg("a/x.proto", "a"), pkg("b/y.proto", "b"), pkg("google/protobuf/any.proto", "google.protobuf")))
	if withImport.ID() != one.ID() {
		t.Error("an import changed the id")
	}

	request := &pluginpb.CodeGeneratorRequest{
		FileToGenerate: []string{"a/x.proto", "b/y.proto"},
		ProtoFile:      []*descriptorpb.FileDescriptorProto{pkg("google/protobuf/any.proto", "google.protobuf"), pkg("a/x.proto", "a"), pkg("b/y.proto", "b")},
	}
	fromPlugin, err := FromRequest(request)
	if err != nil || fromPlugin.ID() != one.ID() {
		t.Errorf("the plugin's id = %s, %v; want %s", fromPlugin.ID(), err, one.ID())
	}
}
