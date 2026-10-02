module github.com/g0itb4/wirebook

go 1.27.1

require (
	connectrpc.com/connect v1.21.0
	connectrpc.com/vanguard v0.4.0
	google.golang.org/genproto/googleapis/api v0.0.0-20260928230214-8a89bd6388cc
	google.golang.org/protobuf v1.36.12
)

require (
	buf.build/gen/go/bufbuild/protovalidate/protocolbuffers/go v1.36.12-20260825204119-511051f7f437.2 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20260921155816-b14227669459 // indirect
)

tool (
	connectrpc.com/connect/cmd/protoc-gen-connect-go
	google.golang.org/protobuf/cmd/protoc-gen-go
)
