// Package image prepares the descriptor set a site is built from, and works
// out which of its files the site documents and which are only imported.
package image

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"slices"
	"strings"

	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/descriptorpb"
	"google.golang.org/protobuf/types/pluginpb"
)

// Image is an encoded FileDescriptorSet and the names of its own files.
type Image struct {
	// Bytes is what the page loads as schema.binpb.
	Bytes []byte
	// Roots are the files the site documents. The others are imports.
	Roots []string
	// Packages are the proto packages of the roots, sorted, each once.
	Packages []string
}

// ID names the API a site documents, for the page to keep one API's
// environments and history apart from another's: every repository is served
// at the same address by `wirebook serve`. It is a short hash of the
// packages, so it stays the same as files and messages come and go.
func (i Image) ID() string {
	sum := sha256.Sum256([]byte(strings.Join(i.Packages, "\n")))
	return hex.EncodeToString(sum[:8])
}

// packages lists the packages of the named files.
func packages(files []*descriptorpb.FileDescriptorProto, roots []string) []string {
	var out []string
	for _, file := range files {
		if slices.Contains(roots, file.GetName()) && !slices.Contains(out, file.GetPackage()) {
			out = append(out, file.GetPackage())
		}
	}
	slices.Sort(out)
	return out
}

// The field of a Buf image that marks a file (buf.alpha.image.v1.ImageFile),
// and in it, the field that says the file is an import.
const (
	bufExtension = 8042
	isImport     = 1
)

// Prefixes of the files that are imports in a plain FileDescriptorSet, which
// does not say. A Buf image does, and needs no guess.
var vendored = []string{"google/protobuf/", "google/api/", "google/rpc/", "google/type/", "buf/validate/"}

// FromBytes reads a FileDescriptorSet or a Buf image, which is one with a
// field more per file.
func FromBytes(data []byte) (Image, error) {
	var set descriptorpb.FileDescriptorSet
	if err := proto.Unmarshal(data, &set); err != nil {
		return Image{}, fmt.Errorf("the descriptor set is not valid: %w", err)
	}
	if len(set.GetFile()) == 0 {
		return Image{}, errors.New("the descriptor set has no files")
	}

	marked := false
	var own, guessed []string
	for _, file := range set.GetFile() {
		imported, isMarked := bufImport(file.ProtoReflect().GetUnknown())
		marked = marked || isMarked
		if !imported {
			own = append(own, file.GetName())
		}
		if !isVendored(file.GetName()) {
			guessed = append(guessed, file.GetName())
		}
	}
	roots := own
	if !marked {
		roots = guessed
	}
	if len(roots) == 0 {
		return Image{}, errors.New("every file of the descriptor set is an import: there is nothing to document")
	}
	return Image{Bytes: data, Roots: roots, Packages: packages(set.GetFile(), roots)}, nil
}

func isVendored(name string) bool {
	for _, prefix := range vendored {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

// bufImport reads the Buf extension out of the unknown fields of a file. It
// reports whether the file is an import, and whether the extension is there.
func bufImport(unknown []byte) (imported, marked bool) {
	for len(unknown) > 0 {
		number, kind, n := protowire.ConsumeTag(unknown)
		if n < 0 {
			return false, marked
		}
		unknown = unknown[n:]
		if number == bufExtension && kind == protowire.BytesType {
			extension, size := protowire.ConsumeBytes(unknown)
			if size < 0 {
				return false, marked
			}
			unknown = unknown[size:]
			marked = true
			imported = imported || flag(extension, isImport)
			continue
		}
		n = protowire.ConsumeFieldValue(number, kind, unknown)
		if n < 0 {
			return false, marked
		}
		unknown = unknown[n:]
	}
	return imported, marked
}

// flag reads a bool field of a message.
func flag(message []byte, field protowire.Number) bool {
	for len(message) > 0 {
		number, kind, n := protowire.ConsumeTag(message)
		if n < 0 {
			return false
		}
		message = message[n:]
		if number == field && kind == protowire.VarintType {
			value, size := protowire.ConsumeVarint(message)
			return size > 0 && value != 0
		}
		n = protowire.ConsumeFieldValue(number, kind, message)
		if n < 0 {
			return false
		}
		message = message[n:]
	}
	return false
}

// FromRequest takes the files a protoc plugin is handed. The request names
// the files to generate; everything else in it is an import.
func FromRequest(request *pluginpb.CodeGeneratorRequest) (Image, error) {
	if len(request.GetFileToGenerate()) == 0 {
		return Image{}, errors.New("the request names no file to generate")
	}
	set := &descriptorpb.FileDescriptorSet{File: request.GetProtoFile()}
	// Deterministic, so that the same protos make the same site.
	data, err := proto.MarshalOptions{Deterministic: true}.Marshal(set)
	if err != nil {
		return Image{}, fmt.Errorf("encode the descriptor set: %w", err)
	}
	roots := request.GetFileToGenerate()
	return Image{Bytes: data, Roots: roots, Packages: packages(request.GetProtoFile(), roots)}, nil
}
