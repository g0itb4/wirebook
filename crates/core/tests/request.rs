//! Requests: every transport, every authentication scheme, and the curl
//! command made from the same value.

mod common;

use serde_json::{Value, json};
use wirebook_core::{Codec, Explorer, Framing, HttpRequest};

/// A spec with the defaults a test does not care about.
fn spec(method: &str, body: Value, transport: &str) -> Value {
    json!({
        "method": method,
        "body": body.to_string(),
        "transport": transport,
        "baseUrl": "http://localhost:8080",
    })
}

fn with(mut spec: Value, key: &str, value: Value) -> Value {
    spec[key] = value;
    spec
}

fn build(explorer: &Explorer, spec: &Value) -> HttpRequest {
    explorer
        .request(&spec.to_string())
        .unwrap_or_else(|e| panic!("{e}\n{spec}"))
}

fn refuse(explorer: &Explorer, spec: &Value) -> String {
    explorer
        .request(&spec.to_string())
        .err()
        .unwrap_or_else(|| panic!("accepted {spec}"))
        .to_string()
}

fn headers(request: &HttpRequest) -> Vec<(&str, &str)> {
    request
        .headers
        .iter()
        .map(|h| (h.name.as_str(), h.value.as_str()))
        .collect()
}

const GET_WIDGET: &str = "fixture.v1.WidgetService/GetWidget";
const WATCH: &str = "fixture.v1.WidgetService/WatchWidgets";

#[test]
fn connect_unary_as_json() {
    let explorer = common::explorer();
    // The body is sent in canonical form, not as it was typed.
    let typed = json!({"method": GET_WIDGET, "body": "{ \"id\" : \"w1\" }", "transport": "connect-json", "baseUrl": "http://localhost:8080/"});
    let request = build(&explorer, &typed);
    assert_eq!(request.verb, "POST");
    assert_eq!(
        request.url,
        "http://localhost:8080/fixture.v1.WidgetService/GetWidget"
    );
    assert_eq!(request.redacted_url, request.url);
    assert_eq!(
        headers(&request),
        [
            ("Content-Type", "application/json"),
            ("Connect-Protocol-Version", "1")
        ]
    );
    assert_eq!(request.body.as_deref(), Some(br#"{"id":"w1"}"#.as_slice()));
    assert_eq!(request.body_text.as_deref(), Some(r#"{"id":"w1"}"#));
    assert_eq!(request.expect.framing, Framing::Unary);
    assert_eq!(request.expect.codec, Codec::Json);
    assert_eq!(request.expect.message, "fixture.v1.GetWidgetResponse");
    // What crosses to the browser: everything but the body bytes.
    assert_eq!(
        serde_json::to_value(&request).unwrap(),
        json!({
            "verb": "POST",
            "url": "http://localhost:8080/fixture.v1.WidgetService/GetWidget",
            "redactedUrl": "http://localhost:8080/fixture.v1.WidgetService/GetWidget",
            "headers": [
                {"name": "Content-Type", "value": "application/json", "redacted": null},
                {"name": "Connect-Protocol-Version", "value": "1", "redacted": null}
            ],
            "bodyText": "{\"id\":\"w1\"}",
            "expect": {"framing": "unary", "codec": "json", "message": "fixture.v1.GetWidgetResponse"}
        })
    );
}

#[test]
fn connect_unary_as_binary() {
    let explorer = common::explorer();
    let request = build(
        &explorer,
        &spec(GET_WIDGET, json!({"id": "w1"}), "connect-proto"),
    );
    assert_eq!(
        headers(&request),
        [
            ("Content-Type", "application/proto"),
            ("Connect-Protocol-Version", "1")
        ]
    );
    assert_eq!(
        request.body.as_deref(),
        Some([0x0a, 0x02, b'w', b'1'].as_slice())
    );
    assert_eq!(request.body_text, None);
    assert_eq!(request.expect.codec, Codec::Proto);
}

#[test]
fn connect_get_puts_the_message_in_the_query() {
    let explorer = common::explorer();
    let get = with(
        spec(GET_WIDGET, json!({"id": "w 1&2"}), "connect-get"),
        "timeoutMs",
        json!(250),
    );
    let request = build(&explorer, &get);
    assert_eq!(request.verb, "GET");
    assert_eq!(
        request.url,
        "http://localhost:8080/fixture.v1.WidgetService/GetWidget?connect=v1&encoding=json&message=%7B%22id%22%3A%22w%201%262%22%7D"
    );
    assert_eq!(headers(&request), [("Connect-Timeout-Ms", "250")]);
    assert_eq!(request.body, None);
    assert_eq!(request.expect.framing, Framing::Unary);

    // Only a method that declares it has no side effects.
    let create = spec(
        "fixture.v1.WidgetService/CreateWidget",
        json!({}),
        "connect-get",
    );
    assert_eq!(
        refuse(&explorer, &create),
        "Connect allows GET only for a unary method declared with no side effects"
    );
    let idempotent = spec(
        "fixture.v1.LibraryService/UpdateBook",
        json!({}),
        "connect-get",
    );
    assert!(refuse(&explorer, &idempotent).starts_with("Connect allows GET only"));
    let stream = spec(WATCH, json!({}), "connect-get");
    assert!(refuse(&explorer, &stream).starts_with("Connect allows GET only"));
}

#[test]
fn a_server_stream_is_enveloped() {
    let explorer = common::explorer();
    let request = build(
        &explorer,
        &with(
            spec(WATCH, json!({"colour": "COLOUR_RED"}), "connect-json"),
            "timeoutMs",
            json!(5000),
        ),
    );
    assert_eq!(
        headers(&request),
        [
            ("Content-Type", "application/connect+json"),
            ("Connect-Protocol-Version", "1"),
            ("Connect-Timeout-Ms", "5000")
        ]
    );
    let text = r#"{"colour":"COLOUR_RED"}"#;
    let mut body = vec![0, 0, 0, 0, 23];
    body.extend_from_slice(text.as_bytes());
    assert_eq!(request.body.as_deref(), Some(body.as_slice()));
    assert_eq!(request.body_text.as_deref(), Some(text));
    assert_eq!(request.expect.framing, Framing::Stream);

    let request = build(
        &explorer,
        &spec(WATCH, json!({"colour": "COLOUR_RED"}), "connect-proto"),
    );
    assert_eq!(
        headers(&request)[0],
        ("Content-Type", "application/connect+proto")
    );
    assert_eq!(
        request.body.as_deref(),
        Some([0, 0, 0, 0, 2, 0x08, 0x01].as_slice())
    );

    assert_eq!(
        refuse(&explorer, &spec(WATCH, json!({}), "rest")),
        "a server stream is sent over Connect, not over REST"
    );
}

#[test]
fn a_client_stream_cannot_be_sent() {
    let explorer = common::explorer();
    for method in [
        "fixture.v1.LibraryService/UploadPages",
        "fixture.v1.LibraryService/DiscussBook",
    ] {
        assert_eq!(
            refuse(&explorer, &spec(method, json!({}), "connect-json")),
            "the method takes a stream of requests, which a browser cannot send"
        );
    }
}

#[test]
fn rest_splits_the_message_between_path_query_and_body() {
    let explorer = common::explorer();
    let rest = |method: &str, body: Value| {
        build(
            &explorer,
            &spec(&format!("fixture.v1.LibraryService/{method}"), body, "rest"),
        )
    };

    // A plain variable is one path segment: a slash in it is escaped.
    let request = build(&explorer, &spec(GET_WIDGET, json!({"id": "a/b c"}), "rest"));
    assert_eq!(
        (request.verb.as_str(), request.url.as_str()),
        ("GET", "http://localhost:8080/v1/widgets/a%2Fb%20c")
    );
    assert_eq!(headers(&request), [("Accept", "application/json")]);
    assert_eq!(request.body, None);
    assert_eq!(request.expect.framing, Framing::Rest);
    assert_eq!(request.expect.message, "fixture.v1.GetWidgetResponse");

    // A variable with a pattern of several segments keeps its slashes.
    let request = rest("GetBook", json!({"name": "shelves/1/books/2"}));
    assert_eq!(request.url, "http://localhost:8080/v1/shelves/1/books/2");

    // Everything outside the path is a query parameter, named as in the
    // proto file, a nested field with dots, a repeated one once per value.
    let request = rest(
        "ListBooks",
        json!({
            "parent": "shelves/1", "pageSize": 10,
            "filter": {"familyName": "Le Guin", "minPages": 100},
            "genres": ["sf", "fantasy"], "publishedAfter": "2020-01-01T00:00:00Z"
        }),
    );
    assert_eq!(
        request.url,
        "http://localhost:8080/v1/shelves/1/books?page_size=10&filter.family_name=Le%20Guin&filter.min_pages=100&genres=sf&genres=fantasy&published_after=2020-01-01T00%3A00%3A00Z"
    );

    // The variable is a nested field, the body is one field, the rest is query.
    let request = rest(
        "UpdateBook",
        json!({"book": {"name": "shelves/1/books/2", "title": "T"}, "updateMask": "title"}),
    );
    assert_eq!(
        (request.verb.as_str(), request.url.as_str()),
        (
            "PATCH",
            "http://localhost:8080/v1/shelves/1/books/2?update_mask=title"
        )
    );
    assert_eq!(request.body_text.as_deref(), Some(r#"{"title":"T"}"#));
    assert_eq!(
        headers(&request),
        [
            ("Content-Type", "application/json"),
            ("Accept", "application/json")
        ]
    );

    // `body: "*"`: every field left is the body, and nothing is query.
    let request = rest(
        "ArchiveBook",
        json!({"name": "shelves/1/books/2", "reason": "old"}),
    );
    assert_eq!(
        (request.verb.as_str(), request.url.as_str()),
        ("POST", "http://localhost:8080/v1/shelves/1/books/2:archive")
    );
    assert_eq!(request.body_text.as_deref(), Some(r#"{"reason":"old"}"#));

    // Two variables, one a 64-bit number, which JSON carries as a string.
    let request = rest(
        "ReplaceBook",
        json!({"shelf": "s", "number": "42", "book": {"title": "T"}}),
    );
    assert_eq!(
        (request.verb.as_str(), request.url.as_str()),
        ("PUT", "http://localhost:8080/v1/shelves/s/books/42")
    );
    // The body field is absent: an empty object is sent.
    let request = rest("ReplaceBook", json!({"shelf": "s", "number": "42"}));
    assert_eq!(request.body_text.as_deref(), Some("{}"));

    let request = rest(
        "DeleteBook",
        json!({"name": "shelves/1/books/2", "force": true}),
    );
    assert_eq!(
        (request.verb.as_str(), request.url.as_str()),
        (
            "DELETE",
            "http://localhost:8080/v1/shelves/1/books/2?force=true"
        )
    );

    let request = rest("CheckBook", json!({"name": "any/thing"}));
    assert_eq!(
        (request.verb.as_str(), request.url.as_str()),
        ("HEAD", "http://localhost:8080/v1/any/thing")
    );

    // The second binding of a method, and a timeout, which REST has no header for.
    let second = with(
        with(
            spec(
                "fixture.v1.LibraryService/GetBook",
                json!({"name": "b7"}),
                "rest",
            ),
            "binding",
            json!(1),
        ),
        "timeoutMs",
        json!(100),
    );
    let request = build(&explorer, &second);
    assert_eq!(request.url, "http://localhost:8080/v1/books/b7");
    assert_eq!(headers(&request), [("Accept", "application/json")]);
}

#[test]
fn rest_refuses_what_it_cannot_express() {
    let explorer = common::explorer();
    let rest = |method: &str, body: Value| {
        refuse(
            &explorer,
            &spec(&format!("fixture.v1.LibraryService/{method}"), body, "rest"),
        )
    };

    assert_eq!(
        rest("GetBook", json!({})),
        "the field name has no value in the request body"
    );
    assert_eq!(
        rest("GetBook", json!({"name": ""})),
        "the path variable name needs a value that is not empty"
    );
    assert_eq!(
        rest("UpdateBook", json!({"updateMask": "title"})),
        "the field book.name has no value in the request body"
    );
    assert_eq!(
        rest(
            "ListBooks",
            json!({"parent": "shelves/1", "labels": {"a": "b"}})
        ),
        "the field labels cannot be sent as a query parameter"
    );
    assert_eq!(
        rest(
            "ListBooks",
            json!({"parent": "shelves/1", "authors": [{"familyName": "x"}]})
        ),
        "the field authors cannot be sent as a query parameter"
    );
    let third = with(
        spec(
            "fixture.v1.LibraryService/GetBook",
            json!({"name": "b"}),
            "rest",
        ),
        "binding",
        json!(2),
    );
    assert_eq!(
        refuse(&explorer, &third),
        "the method has no REST binding number 2"
    );
    let none = spec("fixture.legacy.v1.OldService/Ping", json!({}), "rest");
    assert_eq!(
        refuse(&explorer, &none),
        "the method has no REST binding number 0"
    );
}

#[test]
fn the_request_must_name_a_method_and_carry_a_valid_body() {
    let explorer = common::explorer();
    for method in [
        "fixture.v1.WidgetService/Nope",
        "fixture.v1.Nope/GetWidget",
        "no slash",
    ] {
        assert_eq!(
            refuse(&explorer, &spec(method, json!({}), "connect-json")),
            format!("the schema has no method {method}")
        );
    }
    // A leading slash, as in a URL path, is accepted.
    build(
        &explorer,
        &spec(
            "/fixture.v1.WidgetService/GetWidget",
            json!({}),
            "connect-json",
        ),
    );

    let message = refuse(
        &explorer,
        &spec(GET_WIDGET, json!({"nope": 1}), "connect-json"),
    );
    assert!(
        message.starts_with("the body is not a valid message: unknown field \"nope\""),
        "{message}"
    );

    assert!(
        explorer
            .request("{")
            .err()
            .unwrap()
            .to_string()
            .starts_with("the request is not valid: ")
    );
    let extra = with(
        spec(GET_WIDGET, json!({}), "connect-json"),
        "surprise",
        json!(1),
    );
    assert!(
        refuse(&explorer, &extra).starts_with("the request is not valid: unknown field `surprise`")
    );
    let transport = spec(GET_WIDGET, json!({}), "grpc");
    assert!(
        refuse(&explorer, &transport)
            .starts_with("the request is not valid: unknown variant `grpc`")
    );
}

#[test]
fn the_base_url_is_an_origin_or_a_path_on_this_one() {
    let explorer = common::explorer();
    let url = |base: &str| {
        let spec = with(
            spec(GET_WIDGET, json!({}), "connect-json"),
            "baseUrl",
            json!(base),
        );
        explorer
            .request(&spec.to_string())
            .map(|request| request.url)
            .map_err(|e| e.to_string())
    };
    let path = "/fixture.v1.WidgetService/GetWidget";
    assert_eq!(
        url("https://api.example.com"),
        Ok(format!("https://api.example.com{path}"))
    );
    assert_eq!(
        url("  https://api.example.com/prefix//  "),
        Ok(format!("https://api.example.com/prefix{path}"))
    );
    assert_eq!(url("/proxy"), Ok(format!("/proxy{path}")));
    // The site's own origin.
    assert_eq!(url("/"), Ok(path.to_string()));
    for bad in [
        "",
        "   ",
        "localhost:8080",
        "ftp://x",
        "javascript:alert(1)",
    ] {
        assert_eq!(
            url(bad),
            Err("the base URL must start with http://, https:// or a single /".to_string()),
            "{bad:?}"
        );
    }
    for bad in [
        "http://x/?a=1",
        "http://x/#f",
        "http://x y",
        "http://x\u{7}",
    ] {
        assert_eq!(
            url(bad),
            Err(
                "the base URL must not have spaces, a backslash, a query or a fragment".to_string()
            ),
            "{bad:?}"
        );
    }
}

#[test]
fn custom_headers_are_checked_and_never_set_twice() {
    let explorer = common::explorer();
    let headers_spec =
        |list: Value| with(spec(GET_WIDGET, json!({}), "connect-json"), "headers", list);

    let request = build(
        &explorer,
        &headers_spec(json!([{"name": " X-Trace ", "value": " abc "}])),
    );
    assert_eq!(headers(&request)[2], ("X-Trace", "abc"));

    assert_eq!(
        refuse(
            &explorer,
            &headers_spec(json!([{"name": "Bad Name", "value": "x"}]))
        ),
        "\"Bad Name\" is not a header name"
    );
    assert_eq!(
        refuse(
            &explorer,
            &headers_spec(json!([{"name": "", "value": "x"}]))
        ),
        "\"\" is not a header name"
    );
    for value in ["a\r\nX-B: b", "tab\there", "snow \u{2603}", "caf\u{e9}"] {
        assert_eq!(
            refuse(
                &explorer,
                &headers_spec(json!([{"name": "X-A", "value": value}]))
            ),
            "the value of the header X-A must be plain ASCII text",
            "{value:?}"
        );
    }
    assert_eq!(
        refuse(
            &explorer,
            &headers_spec(json!([{"name": "content-type", "value": "text/plain"}]))
        ),
        "the header content-type is set twice"
    );
    let both = with(
        headers_spec(json!([{"name": "authorization", "value": "Bearer a"}])),
        "auth",
        json!({"scheme": "bearer", "token": "b"}),
    );
    assert_eq!(
        refuse(&explorer, &both),
        "the header Authorization is set twice"
    );
}

#[test]
fn every_scheme_reaches_every_transport() {
    let explorer = common::explorer();
    let schemes = [
        (
            json!({"scheme": "bearer", "token": " abc.def "}),
            "Authorization",
            "Bearer abc.def",
            "Bearer $TOKEN",
        ),
        // RFC 7617: base64 of "user:pass", and the password may hold a colon.
        (
            json!({"scheme": "basic", "username": "Aladdin", "password": "open:sesame"}),
            "Authorization",
            "Basic QWxhZGRpbjpvcGVuOnNlc2FtZQ==",
            "Basic $BASIC_CREDENTIALS",
        ),
        (
            json!({"scheme": "api-key", "value": "k-1"}),
            "X-API-Key",
            "k-1",
            "$API_KEY",
        ),
        (
            json!({"scheme": "api-key", "name": "X-Custom", "value": "k-1", "location": "header"}),
            "X-Custom",
            "k-1",
            "$API_KEY",
        ),
    ];
    let id = json!({"id": "w"});
    let calls = [
        (GET_WIDGET, "connect-json", id.clone()),
        (GET_WIDGET, "connect-proto", id.clone()),
        (GET_WIDGET, "connect-get", id.clone()),
        (GET_WIDGET, "rest", id),
        (WATCH, "connect-json", json!({})),
    ];
    for (auth, name, value, redacted) in &schemes {
        for (method, transport, body) in &calls {
            let request = build(
                &explorer,
                &with(spec(method, body.clone(), transport), "auth", auth.clone()),
            );
            let header = request.headers.last().unwrap();
            assert_eq!(
                (header.name.as_str(), header.value.as_str()),
                (*name, *value),
                "{transport}"
            );
            assert_eq!(header.redacted.as_deref(), Some(*redacted));
            assert_eq!(request.redacted_url, request.url);
            // The other headers carry no secret.
            assert!(
                request.headers[..request.headers.len() - 1]
                    .iter()
                    .all(|h| h.redacted.is_none())
            );
        }
    }

    // A key in the query: in the URL, escaped, and after the other parameters.
    let key = json!({"scheme": "api-key", "name": "key", "value": "k&1 2", "location": "query"});
    for (method, transport, body) in &calls {
        let request = build(
            &explorer,
            &with(spec(method, body.clone(), transport), "auth", key.clone()),
        );
        let separator = if *transport == "connect-get" {
            '&'
        } else {
            '?'
        };
        assert!(
            request.url.ends_with(&format!("{separator}key=k%261%202")),
            "{}",
            request.url
        );
        assert!(
            request
                .redacted_url
                .ends_with(&format!("{separator}key=$API_KEY")),
            "{}",
            request.redacted_url
        );
        assert!(!request.redacted_url.contains("k%261"));
        assert!(request.headers.iter().all(|h| h.redacted.is_none()));
    }

    // No scheme, said or unsaid: no credential.
    for auth in [json!({"scheme": "none"}), Value::Null] {
        let mut spec = spec(GET_WIDGET, json!({}), "connect-json");
        if !auth.is_null() {
            spec["auth"] = auth;
        }
        assert_eq!(build(&explorer, &spec).headers.len(), 2);
    }
}

#[test]
fn a_credential_that_cannot_be_sent_is_refused() {
    let explorer = common::explorer();
    let auth = |auth: Value| {
        refuse(
            &explorer,
            &with(spec(GET_WIDGET, json!({}), "connect-json"), "auth", auth),
        )
    };

    for token in ["", "   ", "two words", "a\nb", "t\u{f6}ken"] {
        assert_eq!(
            auth(json!({"scheme": "bearer", "token": token})),
            "the bearer token must be one word, and not empty"
        );
    }
    for username in ["", "a:b"] {
        assert_eq!(
            auth(json!({"scheme": "basic", "username": username, "password": "p"})),
            "the user name must not be empty or contain a colon"
        );
    }
    assert_eq!(
        auth(json!({"scheme": "basic", "username": "u", "password": "p\n"})),
        "the user name and password must not contain control characters"
    );
    for value in ["", "a\rb", "k\u{e9}y"] {
        assert_eq!(
            auth(json!({"scheme": "api-key", "value": value})),
            "the API key must be plain ASCII text, and not empty"
        );
    }
    for name in ["", "two words", "a:b"] {
        assert_eq!(
            auth(json!({"scheme": "api-key", "name": name, "value": "k"})),
            "the API key name must be a header or parameter name"
        );
    }
    assert!(
        auth(json!({"scheme": "oauth2"}))
            .starts_with("the request is not valid: unknown variant `oauth2`")
    );
    assert!(
        auth(json!({"scheme": "bearer", "token": "t", "extra": 1}))
            .starts_with("the request is not valid: ")
    );
}

#[test]
fn curl_shows_what_is_sent_and_can_hide_the_secret() {
    let explorer = common::explorer();
    let curl = |spec: &Value, redact: bool| explorer.curl(&spec.to_string(), redact).unwrap();

    let bearer = with(
        spec(GET_WIDGET, json!({"id": "it's"}), "connect-json"),
        "auth",
        json!({"scheme": "bearer", "token": "s3cr3t"}),
    );
    assert_eq!(
        curl(&bearer, true),
        concat!(
            "curl --globoff -X POST 'http://localhost:8080/fixture.v1.WidgetService/GetWidget' \\\n",
            "  -H 'Content-Type: application/json' \\\n",
            "  -H 'Connect-Protocol-Version: 1' \\\n",
            // The text in single quotes, the variable alone in double quotes.
            "  -H 'Authorization: Bearer '\"$TOKEN\" \\\n",
            // A quote in the body is closed, escaped and opened again.
            "  --data '{\"id\":\"it'\\''s\"}'"
        )
    );
    assert!(!curl(&bearer, true).contains("s3cr3t"));
    assert!(curl(&bearer, false).contains("  -H 'Authorization: Bearer s3cr3t' \\\n"));

    let basic = with(
        spec(GET_WIDGET, json!({"id": "w"}), "rest"),
        "auth",
        json!({"scheme": "basic", "username": "u", "password": "p"}),
    );
    assert_eq!(
        curl(&basic, true),
        "curl --globoff -X GET 'http://localhost:8080/v1/widgets/w' \\\n  -H 'Accept: application/json' \\\n  -H 'Authorization: Basic '\"$BASIC_CREDENTIALS\""
    );

    // A key in the query: the URL in single quotes up to the key.
    let key = with(
        spec(GET_WIDGET, json!({"id": "w"}), "connect-get"),
        "auth",
        json!({"scheme": "api-key", "name": "key", "value": "k1", "location": "query"}),
    );
    assert_eq!(
        curl(&key, true),
        "curl --globoff -X GET 'http://localhost:8080/fixture.v1.WidgetService/GetWidget?connect=v1&encoding=json&message=%7B%22id%22%3A%22w%22%7D&key='\"$API_KEY\""
    );
    assert!(curl(&key, false).ends_with("&key=k1'"));
    // A key in a header, whose value is the variable and nothing else.
    let header = with(
        spec(GET_WIDGET, json!({"id": "w"}), "connect-get"),
        "auth",
        json!({"scheme": "api-key", "value": "k1"}),
    );
    assert!(curl(&header, true).ends_with("  -H 'X-API-Key: '\"$API_KEY\""));

    // A binary body goes through base64.
    let binary = spec(GET_WIDGET, json!({"id": "w1"}), "connect-proto");
    assert_eq!(
        curl(&binary, true),
        concat!(
            "echo CgJ3MQ== | base64 --decode | curl --globoff -X POST 'http://localhost:8080/fixture.v1.WidgetService/GetWidget' \\\n",
            "  -H 'Content-Type: application/proto' \\\n",
            "  -H 'Connect-Protocol-Version: 1' \\\n",
            "  --data-binary @-"
        )
    );
    // So does an enveloped JSON body: its first bytes are not text.
    let stream = spec(WATCH, json!({}), "connect-json");
    assert!(
        curl(&stream, true)
            .starts_with("echo AAAAAAJ7fQ== | base64 --decode | curl --globoff -X POST ")
    );

    let head = spec(
        "fixture.v1.LibraryService/CheckBook",
        json!({"name": "x"}),
        "rest",
    );
    assert!(curl(&head, true).starts_with("curl --globoff --head 'http://localhost:8080/v1/x' "));

    assert!(explorer.curl("{", true).is_err());
}

/// Whatever is pasted into a terminal must be one command. Every part that
/// someone else may have written (a URL from an imported environment, a
/// header, a body) stays inside single quotes, redacted or not.
#[test]
fn nothing_in_a_curl_command_is_read_by_the_shell() {
    let explorer = common::explorer();
    let hostile = "$(touch /tmp/pwned)`id`\";!rm -rf ~;'";
    let spec = json!({
        "method": GET_WIDGET,
        "body": json!({"id": hostile}).to_string(),
        "transport": "connect-json",
        "baseUrl": "http://localhost:8080/$(id)`id`!x'y\"z",
        "headers": [{"name": "X-$id`'!", "value": hostile}],
        "auth": {"scheme": "api-key", "name": "k$`'!", "value": "v$(id)`'\"!", "location": "query"},
    });
    for redact in [true, false] {
        let command = explorer.curl(&spec.to_string(), redact).unwrap();
        // Take away every single-quoted span, and the escaped quotes between
        // them. What is left is what the shell itself reads.
        let mut bare = String::new();
        let mut quoted = false;
        let mut chars = command.chars().peekable();
        while let Some(c) = chars.next() {
            match (c, quoted) {
                ('\'', _) => quoted = !quoted,
                ('\\', false) if chars.peek() == Some(&'\'') => {
                    chars.next();
                }
                (_, false) => bare.push(c),
                (_, true) => {}
            }
        }
        assert!(!quoted, "a quote is left open:\n{command}");
        let expected = if redact {
            "curl --globoff -X POST \"$API_KEY\" \\\n  -H  \\\n  -H  \\\n  -H  \\\n  --data "
        } else {
            "curl --globoff -X POST  \\\n  -H  \\\n  -H  \\\n  -H  \\\n  --data "
        };
        assert_eq!(bare, expected, "{command}");
    }
}
