//! Inputs written by someone who means harm: a proto file, an environment
//! from an imported file, a value pasted from elsewhere. Each must be refused
//! by name, or made harmless.

mod common;

use buffa::Message;
use buffa_descriptor::generated::descriptor::{
    DescriptorProto, FileDescriptorProto, FileDescriptorSet, MethodDescriptorProto, MethodOptions,
    ServiceDescriptorProto,
};
use serde_json::{Value, json};
use wirebook_core::{Explorer, scrub};

fn spec(method: &str, body: Value, transport: &str, base: &str) -> String {
    json!({"method": method, "body": body.to_string(), "transport": transport, "baseUrl": base})
        .to_string()
}

const GET_WIDGET: &str = "fixture.v1.WidgetService/GetWidget";

#[test]
fn a_base_url_cannot_leave_the_origin_it_seems_to_name() {
    let explorer = common::explorer();
    let build = |base: &str| {
        explorer
            .request(&spec(GET_WIDGET, json!({}), "connect-json", base))
            .map(|request| request.url)
            .map_err(|e| e.to_string())
    };
    // To a browser, both of these are another host, not a path on this one.
    assert_eq!(
        build("//evil.example"),
        Err("the base URL must start with http://, https:// or a single /".to_string())
    );
    for base in [
        "/\\evil.example",
        "http://good.example\\@evil.example",
        "/proxy\\..\\x",
    ] {
        assert_eq!(
            build(base),
            Err(
                "the base URL must not have spaces, a backslash, a query or a fragment".to_string()
            ),
            "{base}"
        );
    }
    // A credential in the URL is in every log on the way.
    for base in [
        "https://user:pass@api.example",
        "http://token@api.example/prefix",
    ] {
        assert_eq!(
            build(base),
            Err("the base URL must not carry a user name or a password: set them under Authentication".to_string()),
            "{base}"
        );
    }
    for base in ["http://", "https:///path"] {
        assert_eq!(
            build(base),
            Err("the base URL has no host".to_string()),
            "{base}"
        );
    }
    // An @ further on is a path, and is fine.
    assert_eq!(
        build("https://api.example/@v1"),
        Ok("https://api.example/@v1/fixture.v1.WidgetService/GetWidget".to_string())
    );
}

#[test]
fn a_path_variable_cannot_climb_out_of_its_path() {
    let explorer = common::explorer();
    let rest = |method: &str, body: Value| {
        explorer
            .request(&spec(method, body, "rest", "http://localhost:8080"))
            .map(|request| request.url)
            .map_err(|e| e.to_string())
    };
    let refused = |field: &str| {
        Err(format!(
            "the path variable {field} must not be \".\" or \"..\", which a URL reads as a directory"
        ))
    };
    // One segment: the browser would resolve it, escaped or not.
    for id in [".", ".."] {
        assert_eq!(rest(GET_WIDGET, json!({"id": id})), refused("id"), "{id}");
    }
    // Several segments: any one of them.
    for name in ["shelves/../books/x", "../x", "a/b/..", "a/./b"] {
        assert_eq!(
            rest("fixture.v1.LibraryService/CheckBook", json!({"name": name})),
            refused("name"),
            "{name}"
        );
    }
    // In one segment a slash is escaped, so this is a name, not a climb; and
    // a percent sign is escaped too, so an escaped dot stays text.
    assert_eq!(
        rest(GET_WIDGET, json!({"id": "a/../b"})),
        Ok("http://localhost:8080/v1/widgets/a%2F..%2Fb".to_string())
    );
    assert_eq!(
        rest(GET_WIDGET, json!({"id": "%2e%2e"})),
        Ok("http://localhost:8080/v1/widgets/%252e%252e".to_string())
    );
    assert_eq!(
        rest(GET_WIDGET, json!({"id": "..."})),
        Ok("http://localhost:8080/v1/widgets/...".to_string())
    );
}

#[test]
fn a_header_the_browser_would_drop_is_refused_by_name() {
    let explorer = common::explorer();
    let with_header = |name: &str| {
        let spec = json!({
            "method": GET_WIDGET, "body": "{}", "transport": "connect-json",
            "baseUrl": "http://localhost:8080", "headers": [{"name": name, "value": "x"}]
        });
        explorer
            .request(&spec.to_string())
            .map(|_| ())
            .map_err(|e| e.to_string())
    };
    for name in [
        "Cookie",
        "host",
        "Origin",
        "Referer",
        "Content-Length",
        "Proxy-Authorization",
        "Sec-Fetch-Site",
        "TE",
        "Via",
    ] {
        assert_eq!(
            with_header(name),
            Err(format!(
                "a browser does not let a page set the header {name}"
            ))
        );
    }
    for name in ["X-Trace", "Accept-Language", "Seconds", "Proxied"] {
        assert_eq!(with_header(name), Ok(()), "{name}");
    }
    // The same for the header of an API key.
    let key = json!({
        "method": GET_WIDGET, "body": "{}", "transport": "connect-json", "baseUrl": "http://localhost:8080",
        "auth": {"scheme": "api-key", "name": "Cookie", "value": "k"}
    });
    assert_eq!(
        explorer.request(&key.to_string()).unwrap_err().to_string(),
        "a browser does not let a page set the header Cookie"
    );
    // As a query parameter, that name is only a name.
    let query = json!({
        "method": GET_WIDGET, "body": "{}", "transport": "connect-json", "baseUrl": "http://localhost:8080",
        "auth": {"scheme": "api-key", "name": "cookie", "value": "k", "location": "query"}
    });
    assert!(
        explorer
            .request(&query.to_string())
            .unwrap()
            .url
            .ends_with("?cookie=k")
    );
}

fn with_verb(kind: &str) -> Explorer {
    with_rule(kind, "/x")
}

/// The fixture image with GetWidget's REST rule replaced by a custom one:
/// what a hostile proto file could carry. Neither buf nor protoc looks at
/// what the rule says.
fn with_rule(kind: &str, path: &str) -> Explorer {
    let mut set = FileDescriptorSet::decode_from_slice(common::IMAGE).unwrap();
    let file = set
        .file
        .iter_mut()
        .find(|f| f.name.as_deref() == Some("fixture/v1/editions.proto"))
        .unwrap();
    let method = file.service[0]
        .method
        .iter_mut()
        .find(|m| m.name.as_deref() == Some("GetWidget"))
        .unwrap();
    // google.api.http (field 72295728 of MethodOptions) = HttpRule{custom{kind, path}}.
    let mut custom = vec![0x0a, u8::try_from(kind.len()).unwrap()];
    custom.extend_from_slice(kind.as_bytes());
    custom.extend_from_slice(&[0x12, u8::try_from(path.len()).unwrap()]);
    custom.extend_from_slice(path.as_bytes());
    let mut rule = vec![0x42, u8::try_from(custom.len()).unwrap()];
    rule.extend_from_slice(&custom);
    let mut options = Vec::new();
    let mut tag: u64 = (72_295_728 << 3) | 2;
    while tag >= 0x80 {
        options.push(u8::try_from(tag & 0x7f).unwrap() | 0x80);
        tag >>= 7;
    }
    options.push(u8::try_from(tag).unwrap());
    options.push(u8::try_from(rule.len()).unwrap());
    options.extend_from_slice(&rule);
    method.options = MethodOptions::decode_from_slice(&options).unwrap().into();
    Explorer::new(&set.encode_to_vec(), common::ROOTS).unwrap()
}

#[test]
fn a_method_from_a_proto_file_is_one_word_or_it_is_not_sent() {
    let rest = spec(GET_WIDGET, json!({}), "rest", "http://localhost:8080");
    for kind in [
        "GET; rm -rf ~ #",
        "G ET",
        "GET\n",
        "CONNECT",
        "trace",
        "TRACK",
    ] {
        let error = with_verb(kind)
            .request(&rest)
            .map(|r| r.verb)
            .unwrap_err()
            .to_string();
        assert_eq!(
            error,
            format!("the REST binding has the method {kind:?}, which a browser cannot send"),
            "{kind:?}"
        );
    }
    // A method that is a token, but not letters, is quoted in the command.
    let odd = with_verb("M-SEARCH$`id`");
    assert_eq!(odd.request(&rest).unwrap().verb, "M-SEARCH$`id`");
    assert_eq!(
        odd.curl(&rest, true).unwrap(),
        "curl --globoff -X 'M-SEARCH$`id`' 'http://localhost:8080/x' \\\n  -H 'Accept: application/json'"
    );
    assert_eq!(
        with_verb("PURGE").curl(&rest, true).unwrap().lines().next(),
        Some("curl --globoff -X PURGE 'http://localhost:8080/x' \\")
    );
}

#[test]
fn a_field_marked_sensitive_is_taken_out_of_what_is_kept() {
    let schema = common::schema();
    let login = json!({
        "username": "ada",
        "password": "top",
        "previous": {"username": "old", "password": "older", "previous": {"password": "oldest"}},
        "others": [{"username": "b", "password": "p1"}, {"username": "c"}],
        "byDevice": {"phone": {"password": "p2"}, "laptop": {"username": "d"}},
        "proof": {"@type": "type.googleapis.com/fixture.v1.Login", "username": "e", "password": "p3"},
        "loginTime": "2026-10-02T00:00:00Z"
    });
    let scrubbed = scrub(&schema, "fixture.v1.Login", &login.to_string()).unwrap();
    assert_eq!(scrubbed.removed, 6);
    assert!(!scrubbed.body.contains("password"), "{}", scrubbed.body);
    for secret in ["top", "older", "oldest", "p1", "p2", "p3"] {
        assert!(
            !scrubbed.body.contains(&format!("\"{secret}\"")),
            "{secret} in {}",
            scrubbed.body
        );
    }
    assert_eq!(
        serde_json::from_str::<Value>(&scrubbed.body).unwrap(),
        json!({
            "username": "ada",
            "previous": {"username": "old", "previous": {}},
            "others": [{"username": "b"}, {"username": "c"}],
            "byDevice": {"phone": {}, "laptop": {"username": "d"}},
            "proof": {"@type": "type.googleapis.com/fixture.v1.Login", "username": "e"},
            "loginTime": "2026-10-02T00:00:00Z"
        })
    );
    // What is left is still a body the codec accepts, in the order it was.
    assert!(
        scrubbed
            .body
            .starts_with("{\n  \"username\": \"ada\",\n  \"previous\"")
    );
    assert!(
        wirebook_core::validate(&schema, "fixture.v1.Login", &scrubbed.body)
            .unwrap()
            .ok
    );

    // Nothing sensitive: nothing removed. An Any of a type the schema lacks
    // cannot be typed in at all.
    let plain = scrub(&schema, "fixture.v1.GetWidgetRequest", r#"{"id": "w"}"#).unwrap();
    assert_eq!(
        (plain.removed, plain.body.as_str()),
        (0, "{\n  \"id\": \"w\"\n}")
    );
    let any =
        json!({"proof": {"@type": "type.googleapis.com/google.protobuf.Duration", "value": "1s"}});
    assert_eq!(
        scrub(&schema, "fixture.v1.Login", &any.to_string())
            .unwrap()
            .removed,
        0
    );
    // A request that is itself a well-known type.
    assert_eq!(
        scrub(&schema, "google.protobuf.Duration", "\"1s\"")
            .unwrap()
            .body,
        "\"1s\""
    );

    assert!(scrub(&schema, "no.Such", "{}").is_err());
    assert!(scrub(&schema, "fixture.v1.Login", "{").is_err());
    let through = common::explorer()
        .scrub("fixture.v1.Login", r#"{"password": "x"}"#)
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&through).unwrap(),
        json!({"body": "{}", "removed": 1})
    );
}

#[test]
fn a_path_from_a_proto_file_cannot_move_the_request_to_another_host() {
    let send = |path: &str, base: &str, body: Value| {
        with_rule("GET", path)
            .request(&spec(GET_WIDGET, body, "rest", base))
            .map(|request| request.url)
            .map_err(|e| e.to_string())
    };
    // Joined to "https://staging.example.com", each of these names a host,
    // a port or a user that the base URL did not.
    for path in [
        ".evil.example/v1/{id}",
        ":8443/v1/{id}",
        "@evil.example/v1/{id}",
        "evil/{id}",
        "/v1\\evil/{id}",
        "/v1/{id}?next=//evil.example",
        "/v1/{id}#x",
        "/v1/ {id}",
    ] {
        let error = send(path, "https://staging.example.com", json!({"id": "w"})).unwrap_err();
        assert!(
            error.starts_with(&format!("the path template {path:?} is not a path: ")),
            "{path:?}: {error}"
        );
    }
    // With a base URL on this origin, two slashes would be a host.
    for path in ["//evil.example/{id}", "/\\evil.example/{id}"] {
        assert!(send(path, "/", json!({"id": "w"})).is_err(), "{path:?}");
    }
    assert_eq!(
        send("//evil.example/{id}", "/", json!({"id": "w"})),
        Err(
            "the request would go to //evil.example/w, which is not under the base URL".to_string()
        )
    );
    // The same through a value: a variable of several segments keeps its
    // slashes, and a value that starts with one would make two.
    assert_eq!(
        send("/{id=**}", "/", json!({"id": "/evil.example/x"})),
        Err(
            "the request would go to //evil.example/x, which is not under the base URL".to_string()
        )
    );
    assert_eq!(
        send("/{id=**}", "https://api.example.com", json!({"id": "/evil.example/x"})),
        Err("the request would go to https://api.example.com//evil.example/x, which is not under the base URL".to_string())
    );
    // A path is a path.
    assert_eq!(
        send(
            "/v1/{id=**}",
            "https://api.example.com",
            json!({"id": "a/b"})
        ),
        Ok("https://api.example.com/v1/a/b".to_string())
    );
}

#[test]
fn a_service_or_method_that_is_not_named_with_identifiers_is_not_called() {
    // A descriptor set made by hand: buf would not write these names.
    let set = |service: &str, method: &str| {
        let file = FileDescriptorProto {
            name: Some("odd.proto".to_string()),
            syntax: Some("proto3".to_string()),
            message_type: vec![DescriptorProto {
                name: Some("M".to_string()),
                ..Default::default()
            }],
            service: vec![ServiceDescriptorProto {
                name: Some(service.to_string()),
                method: vec![MethodDescriptorProto {
                    name: Some(method.to_string()),
                    input_type: Some(".M".to_string()),
                    output_type: Some(".M".to_string()),
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        };
        FileDescriptorSet {
            file: vec![file],
            ..Default::default()
        }
        .encode_to_vec()
    };
    for (service, method) in [
        ("\\evil.example", "M"),
        ("S", "M?x=1"),
        ("S@evil", "M"),
        ("S", "a b"),
        ("S", "#"),
    ] {
        // Such a set may not load at all; when it does, the method is not sent.
        if let Ok(explorer) = Explorer::new(&set(service, method), "[]") {
            let request = json!({"method": format!("{service}/{method}"), "body": "{}", "transport": "connect-json", "baseUrl": "/"});
            let error = explorer
                .request(&request.to_string())
                .map(|r| r.url)
                .unwrap_err()
                .to_string();
            assert!(
                error.contains("is not named with identifiers")
                    || error.starts_with("the schema has no method"),
                "{service}/{method}: {error}"
            );
        }
    }
    // Plain names are sent, without a package too.
    let explorer = Explorer::new(&set("Plain_1", "Do"), "[]").unwrap();
    let request =
        json!({"method": "Plain_1/Do", "body": "{}", "transport": "connect-json", "baseUrl": "/"});
    assert_eq!(
        explorer.request(&request.to_string()).unwrap().url,
        "/Plain_1/Do"
    );
}

/// A response is whatever a server chose to send. Bytes that are almost a
/// message, almost a frame, almost JSON must be refused in words, never by
/// taking the page down: in the browser a panic ends the core.
#[test]
fn no_response_makes_the_core_panic() {
    let explorer = common::explorer();
    let schema = common::schema();
    let message = "fixture.v1.GetWidgetResponse";
    let widget = json!({"widget": {
        "id": "w", "quantity": 7, "serial": "9", "ratio": 0.5, "payload": "AAEC", "tags": ["a", "b"],
        "scores": [1, 2], "stock": {"a": 1}, "partsBySerial": {"4": {"name": "p"}},
        "mainPart": {"name": "m"}, "delimitedPart": {"name": "d"}, "createTime": "2026-10-02T00:00:00Z",
        "detail": {"@type": "type.googleapis.com/fixture.v1.GetWidgetRequest", "id": "i"},
        "salvagedFrom": {"name": "s"}
    }});
    let wire = wirebook_core::encode(&schema, message, &widget.to_string()).unwrap();
    let text = widget.to_string().into_bytes();
    let mut framed = vec![0u8];
    framed.extend_from_slice(&u32::try_from(wire.len()).unwrap().to_be_bytes());
    framed.extend_from_slice(&wire);

    // A fixed sequence, so that a failure can be run again.
    let mut state: u64 = 0x9e37_79b9_7f4a_7c15;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    let expects = |framing: &str, codec: &str| {
        json!({"framing": framing, "codec": codec, "message": message}).to_string()
    };
    for round in 0..4000 {
        let source = [&wire, &text, &framed][round % 3];
        let mut bytes = source.clone();
        for _ in 0..=(next() % 4) {
            let at = usize::try_from(next()).unwrap_or(0) % bytes.len().max(1);
            match next() % 4 {
                0 if !bytes.is_empty() => bytes[at] = u8::try_from(next() % 256).unwrap(),
                1 if !bytes.is_empty() => bytes.truncate(at),
                2 => bytes.insert(at.min(bytes.len()), u8::try_from(next() % 256).unwrap()),
                _ => bytes.extend_from_slice(&source[..at.min(source.len())]),
            }
        }
        let status = [200, 200, 404, 500][round % 4];
        for codec in ["json", "proto"] {
            for framing in ["unary", "rest", "stream"] {
                explorer
                    .response(&expects(framing, codec), status, &bytes)
                    .unwrap();
            }
            explorer.frames(&expects("stream", codec), &bytes).unwrap();
        }
        let _ = wirebook_core::decode(&schema, message, &bytes);
        if let Ok(body) = std::str::from_utf8(&bytes) {
            let _ = wirebook_core::validate(&schema, message, body);
            let _ = scrub(&schema, message, body);
        }
    }
}
