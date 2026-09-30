// Command benchimage writes a large descriptor set for `just bench`: many
// files, messages and fields, with comments, of the size a big API has.
package main

import (
	"flag"
	"fmt"
	"os"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/descriptorpb"
)

func main() {
	out := flag.String("out", "coverage/bench.binpb", "where to write the set")
	files := flag.Int("files", 50, "proto files")
	messages := flag.Int("messages", 40, "messages per file")
	fields := flag.Int("fields", 12, "fields per message")
	flag.Parse()

	data, err := proto.Marshal(build(*files, *messages, *fields))
	if err == nil {
		err = os.WriteFile(*out, data, 0o644) //nolint:gosec // G306: a build artefact, read by the bench.
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "benchimage:", err)
		os.Exit(1)
	}
	fmt.Printf("benchimage: %s, %d files, %d messages, %d bytes\n", *out, *files, *files**messages, len(data))
}

func build(files, messages, fields int) *descriptorpb.FileDescriptorSet {
	set := &descriptorpb.FileDescriptorSet{}
	for f := range files {
		pkg := fmt.Sprintf("bench.v%d", f)
		file := &descriptorpb.FileDescriptorProto{
			Name:           proto.String(fmt.Sprintf("bench/v%d/api.proto", f)),
			Package:        proto.String(pkg),
			Syntax:         proto.String("editions"),
			Edition:        descriptorpb.Edition_EDITION_2023.Enum(),
			SourceCodeInfo: &descriptorpb.SourceCodeInfo{},
		}
		comment := func(text string, path ...int32) {
			file.SourceCodeInfo.Location = append(file.SourceCodeInfo.Location, &descriptorpb.SourceCodeInfo_Location{
				Path:            path,
				Span:            []int32{0, 0, 0},
				LeadingComments: proto.String(text),
			})
		}
		service := &descriptorpb.ServiceDescriptorProto{Name: proto.String("BenchService")}
		for m := range messages {
			message := &descriptorpb.DescriptorProto{Name: proto.String(fmt.Sprintf("Message%d", m))}
			comment(fmt.Sprintf(" Message %d of file %d: a record with %d fields.\n", m, f, fields), 4, int32(m))
			for i := range fields {
				field := &descriptorpb.FieldDescriptorProto{
					Name:     proto.String(fmt.Sprintf("field_%d", i)),
					JsonName: proto.String(fmt.Sprintf("field%d", i)),
					Number:   proto.Int32(int32(i + 1)),
					Label:    descriptorpb.FieldDescriptorProto_LABEL_OPTIONAL.Enum(),
					Type:     descriptorpb.FieldDescriptorProto_TYPE_STRING.Enum(),
				}
				switch i % 4 {
				case 1:
					field.Type = descriptorpb.FieldDescriptorProto_TYPE_INT64.Enum()
				case 2:
					field.Label = descriptorpb.FieldDescriptorProto_LABEL_REPEATED.Enum()
				case 3:
					// A field of the message before, in the same file.
					field.Type = descriptorpb.FieldDescriptorProto_TYPE_MESSAGE.Enum()
					field.TypeName = proto.String(fmt.Sprintf(".%s.Message%d", pkg, max(m-1, 0)))
				}
				message.Field = append(message.Field, field)
				comment(fmt.Sprintf(" Field %d, with a sentence of documentation.\n", i), 4, int32(m), 2, int32(i))
			}
			file.MessageType = append(file.MessageType, message)
			if m%4 == 0 {
				name := fmt.Sprintf(".%s.Message%d", pkg, m)
				service.Method = append(service.Method, &descriptorpb.MethodDescriptorProto{
					Name:       proto.String(fmt.Sprintf("Call%d", m)),
					InputType:  proto.String(name),
					OutputType: proto.String(name),
				})
			}
		}
		file.Service = []*descriptorpb.ServiceDescriptorProto{service}
		set.File = append(set.File, file)
	}
	return set
}
