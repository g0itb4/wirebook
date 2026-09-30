// Package plugin is wirebook as a protoc plugin: one entry in buf.gen.yaml,
// and `buf generate` writes the explorer next to the other generated code.
//
// A plugin answers with text, so the site is one HTML file with the core and
// the schema inside it.
package plugin

import (
	"fmt"
	"io"
	"path/filepath"
	"strings"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/descriptorpb"
	"google.golang.org/protobuf/types/pluginpb"

	"github.com/g0itb4/wirebook/internal/config"
	"github.com/g0itb4/wirebook/internal/image"
	"github.com/g0itb4/wirebook/internal/site"
)

// DefaultOutput is the name of the generated file.
const DefaultOutput = "index.html"

// Run reads a CodeGeneratorRequest from in and writes the response to out.
// An error is returned only when that exchange itself fails; a request that
// cannot be honoured is answered with the reason, as the protocol asks.
func Run(in io.Reader, out io.Writer) error {
	data, err := io.ReadAll(in)
	if err != nil {
		return fmt.Errorf("read the request: %w", err)
	}
	var request pluginpb.CodeGeneratorRequest
	if err := proto.Unmarshal(data, &request); err != nil {
		return fmt.Errorf("the input is not a CodeGeneratorRequest: %w", err)
	}
	// A response is flags, numbers and valid text: encoding it cannot fail.
	encoded, _ := proto.Marshal(Generate(&request))
	if _, err := out.Write(encoded); err != nil {
		return fmt.Errorf("write the response: %w", err)
	}
	return nil
}

// Generate makes the response to a request.
func Generate(request *pluginpb.CodeGeneratorRequest) *pluginpb.CodeGeneratorResponse {
	response := &pluginpb.CodeGeneratorResponse{
		// Without these, protoc refuses to hand over a file that uses
		// proto3 optional, or an edition.
		SupportedFeatures: proto.Uint64(uint64(pluginpb.CodeGeneratorResponse_FEATURE_PROTO3_OPTIONAL) |
			uint64(pluginpb.CodeGeneratorResponse_FEATURE_SUPPORTS_EDITIONS)),
		MinimumEdition: proto.Int32(int32(descriptorpb.Edition_EDITION_PROTO2)),
		MaximumEdition: proto.Int32(int32(descriptorpb.Edition_EDITION_2024)),
	}
	name, content, err := generate(request)
	if err != nil {
		response.Error = proto.String("wirebook: " + err.Error())
		return response
	}
	response.File = []*pluginpb.CodeGeneratorResponse_File{{Name: proto.String(name), Content: proto.String(content)}}
	return response
}

// options are the plugin's parameters: `opt:` in buf.gen.yaml.
type options struct {
	config string
	out    string
	title  string
}

func parse(parameter string) (options, error) {
	opts := options{out: DefaultOutput}
	for _, part := range strings.Split(parameter, ",") {
		if part == "" {
			continue
		}
		key, value, _ := strings.Cut(part, "=")
		switch key {
		case "config":
			opts.config = value
		case "out":
			opts.out = value
		case "title":
			opts.title = value
		default:
			return options{}, fmt.Errorf("unknown option %q: the options are config, out and title", key)
		}
	}
	// The name goes back to buf, which writes the file. It stays inside the
	// output directory whatever buf would make of it.
	if opts.out == "" || !filepath.IsLocal(opts.out) || strings.Contains(opts.out, `\`) {
		return options{}, fmt.Errorf("the option out needs a file name inside the output directory; got %q", opts.out)
	}
	return opts, nil
}

func generate(request *pluginpb.CodeGeneratorRequest) (name, content string, err error) {
	opts, err := parse(request.GetParameter())
	if err != nil {
		return "", "", err
	}
	// The plugin runs where buf runs: at the root of the module.
	path := opts.config
	if path == "" {
		path = config.Discover(".")
	}
	file, err := config.Load(path)
	if err != nil {
		return "", "", err
	}
	if opts.title != "" {
		file.Title = opts.title
	}
	img, err := image.FromRequest(request)
	if err != nil {
		return "", "", err
	}
	return opts.out, string(site.SingleFile(img, file.Site(img.ID(), img.Roots, false))), nil
}
