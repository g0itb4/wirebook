# Eliza

The example site: ConnectRPC's Eliza protos, as wirebook documents them,
calling the public demo server from the page. It is what
<https://wirebook.pigface.lol> serves.

`ElizaService` has three methods. `Say` is unary and declared
`NO_SIDE_EFFECTS`, so the console offers Connect GET beside POST.
`Introduce` is server streaming: the sentences arrive one by one. `Converse`
is bidirectional, which a browser cannot do; the page says so instead of a
console.

```sh
just example          # build the site into out/eliza
just example-serve    # serve it at http://127.0.0.1:9000 while editing
```

## What this example does not show

The protos carry no protovalidate rules, no `google.api.http` bindings and
no `*_id` field. So the form shows no rule hints, there is no REST transport
and no picker. The fixture under `testdata/proto` has all of those; the
browser tests run against it.

## Provenance

`proto/connectrpc/eliza/v1/eliza.proto` is the file of the module
`buf.build/connectrpc/eliza`, copyright The Connect Authors, under the
Apache License 2.0 (`LICENSE`). Taken on 2026-10-10 with:

```sh
bunx buf export buf.build/connectrpc/eliza -o examples/eliza/proto
```

Run that again to refresh it.
