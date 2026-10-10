//! The schema, the documentation model, the templates and the search.

mod common;

use buffa::Message;
use buffa_descriptor::generated::descriptor::source_code_info::Location;
use buffa_descriptor::generated::descriptor::{
    DescriptorProto, EnumDescriptorProto, EnumValueDescriptorProto, FieldDescriptorProto,
    FileDescriptorProto, FileDescriptorSet, MethodDescriptorProto, ServiceDescriptorProto,
    SourceCodeInfo,
};
use common::{named, parse};
use serde_json::{Value, json};
use wirebook_core::{Explorer, Schema, Variables, decode, encode, template, validate};

#[test]
fn a_set_that_is_not_one_is_refused() {
    let error = Schema::load(&[0xff, 0xff]).err().unwrap();
    assert!(
        error
            .to_string()
            .starts_with("the descriptor set is not valid: "),
        "{error}"
    );
    let error = Explorer::new(common::IMAGE, "not json").err().unwrap();
    assert!(
        error
            .to_string()
            .starts_with("the options object is not valid: "),
        "{error}"
    );
}

#[test]
fn comments_are_found_for_every_kind_of_declaration() {
    let schema = common::schema();
    assert_eq!(
        schema.doc("fixture.v1.Widget"),
        "A widget, with one field of every kind."
    );
    assert_eq!(schema.doc("fixture.v1.Widget.Part"), "A part of a widget.");
    assert_eq!(schema.doc("fixture.v1.Widget.payload"), "Base64 in JSON.");
    assert_eq!(
        schema.doc("fixture.v1.WidgetService.CreateWidget"),
        "Store a widget."
    );
    assert_eq!(
        schema.doc("fixture.legacy.v1.Priority.PRIORITY_TRIVIAL"),
        "Use PRIORITY_LOW."
    );
    assert_eq!(
        schema.doc("fixture.v1.ListBooksRequest.Filter"),
        "Narrows the list."
    );
    // Lines are joined as written, without the space protoc keeps.
    assert_eq!(
        schema.doc("fixture.v1.LibraryService.ListBooks"),
        "Books on a shelf. Everything outside the path becomes a query parameter."
    );
    // A paragraph wrapped in the source is one line; a blank line, a list
    // item and a numbered line keep theirs.
    assert_eq!(
        schema.doc("fixture.v1.Book"),
        concat!(
            "A book on a shelf. This comment is wrapped by hand, as comments in proto ",
            "files are, and the page joins the lines of a paragraph again.\n",
            "\n",
            "Its name has two parts:\n",
            "  - the shelf\n",
            "  - the book\n",
            "1. A numbered line keeps its place.\n",
            "And running text after a block starts on a line of its own, then goes on."
        )
    );
    assert_eq!(schema.doc("fixture.v1.Widget.tags"), "");
    assert_eq!(schema.doc("no.such.Thing"), "");
}

#[test]
fn a_set_without_source_info_has_no_comments() {
    let mut set = FileDescriptorSet::decode_from_slice(common::IMAGE).unwrap();
    for file in &mut set.file {
        file.source_code_info = Default::default();
    }
    let schema = Schema::load(&set.encode_to_vec()).unwrap();
    assert_eq!(schema.doc("fixture.v1.Widget"), "");
    assert!(schema.message_index("fixture.v1.Widget").is_ok());
}

#[test]
fn files_carry_their_edition_and_whether_they_are_imports() {
    let index = parse(&common::explorer().index());
    let edition = |name: &str| named(&index["files"], name)["edition"].clone();
    assert_eq!(edition("fixture/v1/editions.proto"), "2024");
    assert_eq!(edition("fixture/v1/library.proto"), "2023");
    assert_eq!(edition("fixture/legacy/v1/proto3.proto"), "proto3");
    assert_eq!(edition("fixture/legacy/v1/proto2.proto"), "proto2");
    assert_eq!(
        named(&index["files"], "fixture/v1/editions.proto")["imported"],
        false
    );
    assert_eq!(
        named(&index["files"], "google/api/http.proto")["imported"],
        true
    );
    assert_eq!(
        named(&index["messages"], "google.protobuf.Timestamp")["imported"],
        true
    );
    assert_eq!(
        named(&index["enums"], "google.protobuf.NullValue")["imported"],
        true
    );

    // Without roots, nothing is an import.
    let index = parse(&Explorer::new(common::IMAGE, "{}").unwrap().index());
    assert_eq!(
        named(&index["files"], "google/api/http.proto")["imported"],
        false
    );
}

#[test]
fn fields_are_described_by_their_resolved_features() {
    let index = parse(&common::explorer().index());
    let widget = named(&index["messages"], "fixture.v1.Widget");
    assert_eq!(widget["file"], "fixture/v1/editions.proto");
    assert_eq!(widget["doc"], "A widget, with one field of every kind.");
    let field = |name: &str| named(&widget["fields"], name).clone();

    assert_eq!(
        field("weight_grams"),
        json!({
            "name": "weight_grams", "jsonName": "weightGrams", "number": 4,
            "cardinality": "singular", "kind": "scalar", "type": "uint64", "mapKey": null,
            "presence": "explicit", "oneof": null, "doc": "", "deprecated": false,
            "required": false, "rules": [], "example": null, "reference": null
        })
    );
    assert_eq!(field("quantity")["presence"], "implicit");
    assert_eq!(field("tags")["cardinality"], "repeated");
    assert_eq!(field("tags")["presence"], "");
    assert_eq!(field("colour")["kind"], "enum");
    assert_eq!(field("colour")["type"], "fixture.v1.Colour");
    assert_eq!(field("parts_by_serial")["cardinality"], "map");
    assert_eq!(field("parts_by_serial")["mapKey"], "int64");
    assert_eq!(field("parts_by_serial")["kind"], "message");
    assert_eq!(field("parts_by_serial")["type"], "fixture.v1.Widget.Part");
    assert_eq!(field("factory")["oneof"], "source");
    assert_eq!(field("salvaged_from")["oneof"], "source");

    // The entry message of a map is not a message to the reader.
    let names: Vec<&str> = index["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"fixture.v1.Widget.Part"));
    assert!(
        !names.iter().any(|name| name.ends_with("Entry")),
        "{names:?}"
    );

    // proto2 `required`, and proto3 `optional`, which is not a oneof.
    let order = named(&index["messages"], "fixture.legacy.v1.Order");
    assert_eq!(named(&order["fields"], "id")["presence"], "required");
    let scalars = named(&index["messages"], "fixture.legacy.v1.Scalars");
    assert_eq!(
        named(&scalars["fields"], "optional_value")["presence"],
        "explicit"
    );
    assert_eq!(
        named(&scalars["fields"], "optional_value")["oneof"],
        Value::Null
    );
    assert_eq!(
        named(&scalars["fields"], "sfixed64_value")["type"],
        "sfixed64"
    );
}

#[test]
fn enums_say_whether_they_are_closed() {
    let index = parse(&common::explorer().index());
    assert_eq!(named(&index["enums"], "fixture.v1.Colour")["closed"], false);
    assert_eq!(named(&index["enums"], "fixture.v1.Size")["closed"], true);
    assert_eq!(
        named(&index["enums"], "fixture.legacy.v1.OrderKind")["closed"],
        true
    );
    let priority = named(&index["enums"], "fixture.legacy.v1.Priority");
    assert_eq!(
        named(&priority["values"], "PRIORITY_TRIVIAL"),
        &json!({"name": "PRIORITY_TRIVIAL", "number": 2, "doc": "Use PRIORITY_LOW.", "deprecated": true})
    );
}

#[test]
fn deprecation_is_reported_at_every_level() {
    let index = parse(&common::explorer().index());
    let old = named(&index["messages"], "fixture.legacy.v1.OldThing");
    assert_eq!(old["deprecated"], true);
    assert_eq!(named(&old["fields"], "title")["deprecated"], true);
    assert_eq!(named(&old["fields"], "priority")["deprecated"], false);
    let service = named(&index["services"], "fixture.legacy.v1.OldService");
    assert_eq!(service["deprecated"], true);
    assert_eq!(named(&service["methods"], "Ping")["deprecated"], true);
    assert_eq!(
        named(&index["services"], "fixture.v1.WidgetService")["deprecated"],
        false
    );
}

#[test]
fn methods_list_their_bindings_and_what_can_send_them() {
    let index = parse(&common::explorer().index());
    let widgets = named(&index["services"], "fixture.v1.WidgetService");
    assert_eq!(
        named(&widgets["methods"], "GetWidget"),
        &json!({
            "name": "GetWidget",
            "path": "fixture.v1.WidgetService/GetWidget",
            "doc": "One widget by id. Has no side effects, so Connect allows GET.",
            "deprecated": false,
            "input": "fixture.v1.GetWidgetRequest",
            "output": "fixture.v1.GetWidgetResponse",
            "clientStreaming": false,
            "serverStreaming": false,
            "idempotency": "no_side_effects",
            "http": [{"verb": "GET", "path": "/v1/widgets/{id}", "body": ""}],
            "transports": ["connect-json", "connect-proto", "connect-get", "rest"]
        })
    );
    let create = named(&widgets["methods"], "CreateWidget");
    assert_eq!(
        create["http"],
        json!([{"verb": "POST", "path": "/v1/widgets", "body": "widget"}])
    );
    assert_eq!(
        create["transports"],
        json!(["connect-json", "connect-proto", "rest"])
    );
    let watch = named(&widgets["methods"], "WatchWidgets");
    assert_eq!(watch["serverStreaming"], true);
    assert_eq!(
        watch["transports"],
        json!(["connect-json", "connect-proto"])
    );

    let library = named(&index["services"], "fixture.v1.LibraryService");
    let method = |name: &str| named(&library["methods"], name).clone();
    assert_eq!(
        method("GetBook")["http"],
        json!([
            {"verb": "GET", "path": "/v1/{name=shelves/*/books/*}", "body": ""},
            {"verb": "GET", "path": "/v1/books/{name}", "body": ""}
        ])
    );
    assert_eq!(method("UpdateBook")["idempotency"], "idempotent");
    assert_eq!(method("UpdateBook")["http"][0]["verb"], "PATCH");
    assert_eq!(method("DeleteBook")["http"][0]["verb"], "DELETE");
    assert_eq!(method("ReplaceBook")["http"][0]["verb"], "PUT");
    assert_eq!(
        method("CheckBook")["http"],
        json!([{"verb": "HEAD", "path": "/v1/{name=**}", "body": ""}])
    );
    // A method with a client stream is documented, and cannot be sent.
    assert_eq!(method("UploadPages")["clientStreaming"], true);
    assert_eq!(method("UploadPages")["transports"], json!([]));
    assert_eq!(method("DiscussBook")["transports"], json!([]));
}

#[test]
fn every_template_is_a_body_the_codec_accepts() {
    let explorer = common::explorer();
    let index = parse(&explorer.index());
    for message in index["messages"].as_array().unwrap() {
        let name = message["name"].as_str().unwrap();
        let body = explorer.template(name, "{}").unwrap();
        let verdict = parse(&explorer.validate(name, &body, "{}").unwrap());
        assert_eq!(verdict["ok"], true, "{name}: {verdict}\n{body}");
    }
}

#[test]
fn a_template_shows_every_field_in_declaration_order() {
    let schema = common::schema();
    let widget = template(&schema, "fixture.v1.Widget", &Variables::new()).unwrap();
    assert_eq!(
        serde_json::to_string(&widget).unwrap(),
        concat!(
            r#"{"id":"","quantity":0,"serial":"0","weightGrams":"0","ratio":0,"active":false,"#,
            r#""payload":"","colour":"COLOUR_UNSPECIFIED","size":"SIZE_UNSPECIFIED","tags":[""],"#,
            r#""scores":[0],"stock":{"key":0},"partsBySerial":{"0":{"name":"","count":0}},"#,
            r#""mainPart":{"name":"","count":0},"delimitedPart":{"name":"","count":0},"#,
            // No `detail`: an Any has no example. Of the oneof, the first member only.
            r#""createTime":"1970-01-01T00:00:00Z","shelfLife":"0s","factory":""}"#
        )
    );
    // A message inside itself stops at the first level.
    assert_eq!(
        template(&schema, "fixture.legacy.v1.Tree", &Variables::new()).unwrap(),
        json!({"label": "", "children": []})
    );
    assert_eq!(
        template(&schema, "fixture.legacy.v1.Scalars", &Variables::new()).unwrap()["byFlag"],
        json!({"false": ""})
    );
    assert_eq!(
        template(&schema, "fixture.legacy.v1.WellKnown", &Variables::new()).unwrap(),
        json!({
            "timestamp": "1970-01-01T00:00:00Z", "duration": "0s", "fieldMask": "",
            "structValue": {}, "value": null, "listValue": [], "empty": {},
            "doubleWrapper": 0, "floatWrapper": 0, "int32Wrapper": 0, "uint32Wrapper": 0,
            "int64Wrapper": "0", "uint64Wrapper": "0", "boolWrapper": false,
            "stringWrapper": "", "bytesWrapper": ""
        })
    );
    // Asked for directly, a well-known type gives its own form; an Any, nothing.
    assert_eq!(
        template(&schema, "google.protobuf.Duration", &Variables::new()).unwrap(),
        json!("0s")
    );
    assert_eq!(
        template(&schema, "google.protobuf.Any", &Variables::new()).unwrap(),
        json!({})
    );
    assert_eq!(
        template(&schema, "no.Such", &Variables::new())
            .err()
            .unwrap()
            .to_string(),
        "the schema has no message no.Such"
    );
    // For an editor, the façade indents it.
    assert!(
        common::explorer()
            .template("fixture.v1.GetWidgetRequest", "{}")
            .unwrap()
            .contains("{\n  \"id\": \"\"\n}")
    );
}

#[test]
fn validation_says_where_a_body_is_wrong() {
    let schema = common::schema();
    let ok = validate(&schema, "fixture.v1.Widget", r#"{"id": "w"}"#).unwrap();
    assert_eq!(
        (ok.ok, ok.line, ok.column, ok.message.as_str()),
        (true, 0, 0, "")
    );

    let bad = validate(&schema, "fixture.v1.Widget", "{\n  \"nope\": 1\n}").unwrap();
    assert!(!bad.ok);
    assert_eq!((bad.line, bad.column), (2, 8));
    assert!(
        bad.message.contains("unknown field \"nope\""),
        "{}",
        bad.message
    );

    for body in [
        r#"{"size": "SIZE_HUGE"}"#,
        r#"{"factory": "a", "salvagedFrom": {}}"#,
        r#"{"serial": "not a number"}"#,
        r#"{"id": 5}"#,
        "",
        "[]",
    ] {
        assert!(
            !validate(&schema, "fixture.v1.Widget", body).unwrap().ok,
            "{body}"
        );
    }
    assert!(validate(&schema, "no.Such", "{}").is_err());
}

#[test]
fn search_ranks_names_before_comments_and_own_before_imported() {
    let explorer = common::explorer();
    let hits = |query: &str, limit: usize| parse(&explorer.search(query, limit));

    assert_eq!(hits("", 10), json!([]));
    assert_eq!(hits("   ", 10), json!([]));
    assert_eq!(hits("zzzz no such thing", 10), json!([]));

    // The exact name first, then names that start with it, then the rest.
    let widget = hits("widget", 50);
    assert_eq!(
        widget[0],
        json!({"kind": "message", "name": "fixture.v1.Widget", "page": "fixture.v1.Widget", "doc": "A widget, with one field of every kind."})
    );
    let kinds: Vec<&str> = widget
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["kind"].as_str().unwrap())
        .collect();
    assert!(
        kinds.contains(&"service") && kinds.contains(&"field"),
        "{kinds:?}"
    );

    assert_eq!(
        hits("getwidget", 1),
        json!([{"kind": "method", "name": "fixture.v1.WidgetService/GetWidget", "page": "fixture.v1.WidgetService", "doc": "One widget by id. Has no side effects, so Connect allows GET."}])
    );
    assert_eq!(hits("COLOUR_RED", 1)[0]["kind"], "value");
    assert_eq!(hits("COLOUR_RED", 1)[0]["page"], "fixture.v1.Colour");
    assert_eq!(hits("colour", 1)[0]["kind"], "enum");
    // Found in a comment only.
    assert_eq!(
        hits("base64", 5),
        json!([{"kind": "field", "name": "fixture.v1.Widget.payload", "page": "fixture.v1.Widget", "doc": "Base64 in JSON."}])
    );
    // A name that only contains the query.
    assert_eq!(hits("books_request", 5), json!([]));
    assert_eq!(hits("fixture.v1.book", 1)[0]["name"], "fixture.v1.Book");
    // The site's own declarations before the imported ones of the same rank.
    let any = hits("any", 50);
    let names: Vec<&str> = any
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["name"].as_str().unwrap())
        .collect();
    let own = names
        .iter()
        .position(|name| *name == "fixture.legacy.v1.WellKnown.any")
        .unwrap();
    let imported = names
        .iter()
        .position(|name| *name == "google.protobuf.Any")
        .unwrap();
    assert!(own < imported, "{names:?}");
    assert_eq!(hits("a", 3).as_array().unwrap().len(), 3);
}

#[test]
fn bytes_that_name_a_type_the_schema_lacks_have_no_json_form() {
    // Widget.detail (field 18) holding an Any whose type_url is unknown.
    let url = b"type.googleapis.com/no.Such";
    let mut any = vec![0x0a, u8::try_from(url.len()).unwrap()];
    any.extend_from_slice(url);
    let mut widget = vec![0x92, 0x01, u8::try_from(any.len()).unwrap()];
    widget.extend_from_slice(&any);
    let error = wirebook_core::decode(&common::schema(), "fixture.v1.Widget", &widget).unwrap_err();
    assert!(
        error
            .to_string()
            .starts_with("the message has no JSON form: "),
        "{error}"
    );
    let error = wirebook_core::decode(&common::schema(), "no.Such", &widget).unwrap_err();
    assert_eq!(error.to_string(), "the schema has no message no.Such");
}

#[test]
fn a_file_without_a_package_names_its_types_bare() {
    let location = Location {
        path: vec![4, 0],
        // A trailing comment, when there is no leading one.
        trailing_comments: Some(" Bare, with no package.\n".to_string()),
        ..Default::default()
    };
    let file = FileDescriptorProto {
        name: Some("bare.proto".to_string()),
        syntax: Some("proto3".to_string()),
        message_type: vec![DescriptorProto {
            name: Some("Bare".to_string()),
            ..Default::default()
        }],
        source_code_info: SourceCodeInfo {
            location: vec![location],
            ..Default::default()
        }
        .into(),
        ..Default::default()
    };
    let set = FileDescriptorSet {
        file: vec![file],
        ..Default::default()
    };
    let explorer = Explorer::new(&set.encode_to_vec(), "{}").unwrap();
    let index = parse(&explorer.index());
    assert_eq!(
        index["messages"],
        json!([{
            "name": "Bare", "file": "bare.proto", "imported": false,
            "doc": "Bare, with no package.", "deprecated": false, "rules": [], "fields": []
        }])
    );
}

/// A file made by hand: one message with a field, one enum with a value,
/// one service with a method, and a comment at each of `paths`.
fn commented(message: &str, field: &str, paths: &[&[i32]]) -> Vec<u8> {
    let location = |path: &&[i32]| Location {
        path: path.to_vec(),
        leading_comments: Some(format!(" At {path:?}.\n")),
        ..Default::default()
    };
    let file = FileDescriptorProto {
        name: Some("made.proto".to_string()),
        package: Some("made".to_string()),
        syntax: Some("proto3".to_string()),
        message_type: vec![DescriptorProto {
            name: Some(message.to_string()),
            field: vec![FieldDescriptorProto {
                name: Some(field.to_string()),
                number: Some(1),
                ..Default::default()
            }],
            ..Default::default()
        }],
        enum_type: vec![EnumDescriptorProto {
            name: Some("Kind".to_string()),
            value: vec![EnumValueDescriptorProto {
                name: Some("KIND_ZERO".to_string()),
                number: Some(0),
                ..Default::default()
            }],
            ..Default::default()
        }],
        service: vec![ServiceDescriptorProto {
            name: Some("Maker".to_string()),
            method: vec![MethodDescriptorProto {
                name: Some("Make".to_string()),
                input_type: Some(format!(".made.{message}")),
                output_type: Some(format!(".made.{message}")),
                ..Default::default()
            }],
            ..Default::default()
        }],
        source_code_info: SourceCodeInfo {
            location: paths.iter().map(location).collect(),
            ..Default::default()
        }
        .into(),
        ..Default::default()
    };
    let set = FileDescriptorSet {
        file: vec![file],
        ..Default::default()
    };
    set.encode_to_vec()
}

#[test]
fn a_comment_on_what_is_not_a_declaration_is_not_kept() {
    // A declaration of every kind, and then what protoc also writes a
    // location for: an option, a name, a type; and paths that lead nowhere.
    let declarations: [(&[i32], &str); 6] = [
        (&[4, 0], "made.Thing"),
        (&[4, 0, 2, 0], "made.Thing.size"),
        (&[5, 0], "made.Kind"),
        (&[5, 0, 2, 0], "made.Kind.KIND_ZERO"),
        (&[6, 0], "made.Maker"),
        (&[6, 0, 2, 0], "made.Maker.Make"),
    ];
    let others: [&[i32]; 14] = [
        &[],
        &[2],
        &[4],
        &[4, 0, 1],
        &[4, 0, 2, 0, 1],
        &[4, 0, 7, 0],
        &[5, 0, 3],
        &[5, 0, 2, 0, 3],
        &[6, 0, 3],
        &[6, 0, 2, 0, 4],
        // No such message, enum value or method; and an index below zero.
        &[4, 1],
        &[5, 0, 2, 1],
        &[6, 0, 2, 1],
        &[4, -1],
    ];
    let mut paths: Vec<&[i32]> = others.to_vec();
    paths.extend(declarations.iter().map(|(path, _)| *path));
    let schema = Schema::load(&commented("Thing", "size", &paths)).unwrap();
    for (path, name) in declarations {
        assert_eq!(schema.doc(name), format!("At {path:?}."), "{name}");
    }
    // Nothing else has a comment: not the package, nor a name made of less.
    for name in ["made", "", "made.Thing.", "made.Kind.", "made.Maker."] {
        assert_eq!(schema.doc(name), "", "{name:?}");
    }
}

#[test]
fn search_finds_a_name_outside_ascii_in_any_case() {
    // buf would not write these names; a set made by hand can hold them.
    let image = commented("Größe", "ÄNDERUNG", &[]);
    let explorer = Explorer::new(&image, "{}").unwrap();
    let names = |query: &str| -> Vec<String> {
        let hits = parse(&explorer.search(query, 10));
        let names = hits.as_array().unwrap().iter();
        names
            .map(|hit| hit["name"].as_str().unwrap().to_string())
            .collect()
    };
    assert_eq!(names("GRÖSSE"), Vec::<String>::new());
    assert_eq!(names("größe"), ["made.Größe", "made.Größe.ÄNDERUNG"]);
    assert_eq!(names("GRÖ"), ["made.Größe", "made.Größe.ÄNDERUNG"]);
    assert_eq!(names("änderung"), ["made.Größe.ÄNDERUNG"]);
    assert_eq!(names("Änder"), ["made.Größe.ÄNDERUNG"]);
    assert_eq!(names("sse.änd"), Vec::<String>::new());
    assert_eq!(names("ße.änd"), ["made.Größe.ÄNDERUNG"]);
    // An ASCII name is found the same way, a dot between its two parts too.
    assert_eq!(names("kind.kind"), ["made.Kind.KIND_ZERO"]);
    assert_eq!(names("ND.KIND_z"), ["made.Kind.KIND_ZERO"]);
    assert_eq!(names("kind"), ["made.Kind", "made.Kind.KIND_ZERO"]);
    // No more than asked for, and the best of them.
    assert_eq!(names("m").len(), 6);
    let best = |limit: usize| parse(&explorer.search("m", limit));
    assert_eq!(best(0), json!([]));
    assert_eq!(best(1)[0]["name"], "made.Maker");
    assert_eq!(best(2)[1]["name"], "made.Maker/Make");
}

#[test]
fn the_codec_refuses_what_it_cannot_read() {
    let schema = common::schema();
    assert_eq!(
        encode(&schema, "no.Such", "{}").unwrap_err().to_string(),
        "the schema has no message no.Such"
    );
    let error = encode(&schema, "fixture.v1.Widget", "{")
        .unwrap_err()
        .to_string();
    assert!(
        error.starts_with("the body is not a valid message: "),
        "{error}"
    );
    let error = decode(&schema, "fixture.v1.Widget", &[0x0a, 0x7f])
        .unwrap_err()
        .to_string();
    assert!(
        error.starts_with("the bytes are not a valid message: "),
        "{error}"
    );

    let error = Explorer::new(&[0xff], "{}").err().unwrap().to_string();
    assert!(
        error.starts_with("the descriptor set is not valid: "),
        "{error}"
    );
    assert!(common::explorer().template("no.Such", "{}").is_err());
    assert!(common::explorer().validate("no.Such", "{}", "{}").is_err());
}
