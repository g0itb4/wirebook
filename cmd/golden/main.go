// Command golden writes what protobuf-go, the reference implementation,
// makes of every case in testdata/golden/cases.in.json: the wire bytes and
// the canonical JSON. The Rust core is tested against the result, so the
// codec in the browser agrees with the one a Go server runs.
//
// `just golden` runs it; the output is committed, and CI fails when it is
// stale.
package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
	"google.golang.org/protobuf/types/descriptorpb"
	"google.golang.org/protobuf/types/dynamicpb"
)

// A case names a message and gives it as proto JSON.
type input struct {
	Name    string          `json:"name"`
	Message string          `json:"message"`
	JSON    json.RawMessage `json:"json"`
}

type output struct {
	Name    string          `json:"name"`
	Message string          `json:"message"`
	Input   json.RawMessage `json:"input"`
	// Wire is the deterministic binary encoding, in hex.
	Wire string `json:"wire"`
	// JSON is what protojson prints for the decoded bytes.
	JSON json.RawMessage `json:"json"`
}

func main() {
	image := flag.String("image", "testdata/fixture.binpb", "descriptor set of the fixtures")
	in := flag.String("in", "testdata/golden/cases.in.json", "the cases")
	out := flag.String("out", "testdata/golden/cases.json", "the cases with their expected encodings")
	flag.Parse()

	if err := run(*image, *in, *out); err != nil {
		fmt.Fprintln(os.Stderr, "golden:", err)
		os.Exit(1)
	}
}

func run(imagePath, inPath, outPath string) error {
	image, err := os.ReadFile(imagePath)
	if err != nil {
		return err
	}
	var set descriptorpb.FileDescriptorSet
	if err := proto.Unmarshal(image, &set); err != nil {
		return fmt.Errorf("read %s: %w", imagePath, err)
	}
	files, err := protodesc.NewFiles(&set)
	if err != nil {
		return fmt.Errorf("link %s: %w", imagePath, err)
	}
	types := dynamicpb.NewTypes(files)

	raw, err := os.ReadFile(inPath)
	if err != nil {
		return err
	}
	var cases []input
	if err := json.Unmarshal(raw, &cases); err != nil {
		return fmt.Errorf("read %s: %w", inPath, err)
	}

	results := make([]output, 0, len(cases))
	for _, c := range cases {
		result, err := encode(files, types, c)
		if err != nil {
			return fmt.Errorf("case %q: %w", c.Name, err)
		}
		results = append(results, result)
	}

	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(results); err != nil {
		return err
	}
	return os.WriteFile(outPath, buf.Bytes(), 0o644) //nolint:gosec // G306: a committed test fixture, read by everyone.
}

func encode(files *protoregistry.Files, types *dynamicpb.Types, c input) (output, error) {
	desc, err := files.FindDescriptorByName(protoreflect.FullName(c.Message))
	if err != nil {
		return output{}, err
	}
	md, ok := desc.(protoreflect.MessageDescriptor)
	if !ok {
		return output{}, fmt.Errorf("%s is not a message", c.Message)
	}
	msg := dynamicpb.NewMessage(md)
	if err := (protojson.UnmarshalOptions{Resolver: types}).Unmarshal(c.JSON, msg); err != nil {
		return output{}, err
	}
	wire, err := proto.MarshalOptions{Deterministic: true}.Marshal(msg)
	if err != nil {
		return output{}, err
	}
	text, err := protojson.MarshalOptions{Resolver: types}.Marshal(msg)
	if err != nil {
		return output{}, err
	}
	// protojson varies its whitespace on purpose, so that nobody depends on
	// it. Compacting leaves only what the format defines.
	var compact bytes.Buffer
	if err := json.Compact(&compact, text); err != nil {
		return output{}, err
	}
	var input bytes.Buffer
	if err := json.Compact(&input, c.JSON); err != nil {
		return output{}, err
	}
	return output{
		Name:    c.Name,
		Message: c.Message,
		Input:   input.Bytes(),
		Wire:    hex.EncodeToString(wire),
		JSON:    compact.Bytes(),
	}, nil
}
