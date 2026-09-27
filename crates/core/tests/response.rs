//! Responses: messages, errors with their details, and the frames of a
//! stream.

mod common;

use common::parse;
use serde_json::{Value, json};
use wirebook_core::encode;

fn expect(framing: &str, codec: &str, message: &str) -> String {
    json!({"framing": framing, "codec": codec, "message": message}).to_string()
}

const RESPONSE: &str = "fixture.v1.GetWidgetResponse";

fn read(expect: &str, status: u16, body: &[u8]) -> Value {
    parse(&common::explorer().response(expect, status, body).unwrap())
}

fn error(code: &str, message: &str) -> Value {
    json!({"ok": false, "message": null, "error": {"code": code, "message": message, "details": []}})
}

#[test]
fn a_unary_response_is_decoded_by_its_codec() {
    let widget = json!({"widget": {"id": "w1", "serial": "5", "tags": ["a"]}});
    let ok = json!({"ok": true, "message": widget, "error": null});

    let unary_json = expect("unary", "json", RESPONSE);
    assert_eq!(read(&unary_json, 200, widget.to_string().as_bytes()), ok);
    // A field from a newer server is dropped, not an error.
    let newer = br#"{"widget": {"id": "w1", "serial": "5", "tags": ["a"]}, "addedLater": true}"#;
    assert_eq!(read(&unary_json, 200, newer), ok);

    let wire = encode(&common::schema(), RESPONSE, &widget.to_string()).unwrap();
    assert_eq!(read(&expect("unary", "proto", RESPONSE), 200, &wire), ok);
}

#[test]
fn a_response_that_cannot_be_read_says_so() {
    let unary_json = expect("unary", "json", RESPONSE);
    let unreadable = |body: &[u8], codec: &str| {
        let parsed = read(&expect("unary", codec, RESPONSE), 200, body);
        assert_eq!(parsed["error"]["code"], "invalid_response", "{parsed}");
        parsed["error"]["message"].as_str().unwrap().to_string()
    };
    assert!(unreadable(b"<html>", "json").starts_with("the response is not a valid message: "));
    assert!(unreadable(&[0xff, 0xfe], "json").starts_with("the response is not UTF-8: "));
    assert!(unreadable(&[0x0a, 0x7f], "proto").starts_with("the bytes are not a valid message: "));
    assert_eq!(
        read(&expect("unary", "json", "no.Such"), 200, b"{}"),
        error("invalid_response", "the schema has no message no.Such")
    );

    let explorer = common::explorer();
    assert!(
        explorer
            .response("{", 200, b"")
            .err()
            .unwrap()
            .to_string()
            .starts_with("the expected response is not valid: ")
    );
    assert!(
        explorer
            .frames("{", b"")
            .err()
            .unwrap()
            .to_string()
            .starts_with("the expected response is not valid: ")
    );
    let _ = unary_json;
}

#[test]
fn a_connect_error_is_read_with_its_details() {
    let unary = expect("unary", "json", RESPONSE);
    // "CgF4" is the wire form of GetWidgetRequest{id: "x"}, in base64 without
    // padding, as Connect sends it; "CgF4eA==" is padded, which is tolerated.
    let body = json!({
        "code": "not_found",
        "message": "no widget w9",
        "details": [
            {"type": "fixture.v1.GetWidgetRequest", "value": "CgF4", "debug": {"id": "x"}},
            {"type": "fixture.v1.GetWidgetRequest", "value": "CgJ4eA=="},
            {"type": "some.Unknown", "value": "CgF4"},
            {"type": "fixture.v1.GetWidgetRequest", "value": "not base64!"},
            {}
        ]
    });
    assert_eq!(
        read(&unary, 404, body.to_string().as_bytes()),
        json!({
            "ok": false,
            "message": null,
            "error": {
                "code": "not_found",
                "message": "no widget w9",
                "details": [
                    {"type": "fixture.v1.GetWidgetRequest", "value": {"id": "x"}, "debug": {"id": "x"}},
                    {"type": "fixture.v1.GetWidgetRequest", "value": {"id": "xx"}, "debug": null},
                    {"type": "some.Unknown", "value": null, "debug": null},
                    {"type": "fixture.v1.GetWidgetRequest", "value": null, "debug": null},
                    {"type": "", "value": null, "debug": null}
                ]
            }
        })
    );
    // An error without a message or details.
    assert_eq!(
        read(&unary, 401, br#"{"code": "unauthenticated"}"#),
        error("unauthenticated", "")
    );
    // The same for a stream that never started.
    let stream = expect("stream", "json", RESPONSE);
    assert_eq!(
        read(
            &stream,
            403,
            br#"{"code": "permission_denied", "message": "no"}"#
        ),
        error("permission_denied", "no")
    );
}

#[test]
fn a_status_without_a_connect_error_is_mapped_by_the_protocols_table() {
    let unary = expect("unary", "json", RESPONSE);
    for (status, code) in [
        (400, "internal"),
        (401, "unauthenticated"),
        (403, "permission_denied"),
        (404, "unimplemented"),
        (429, "unavailable"),
        (502, "unavailable"),
        (503, "unavailable"),
        (504, "unavailable"),
        (500, "unknown"),
        (204, "unknown"),
    ] {
        assert_eq!(
            read(&unary, status, b"<html>bad gateway</html>"),
            error(code, &format!("HTTP {status}"))
        );
    }
    // JSON, but not a Connect error.
    assert_eq!(
        read(&unary, 404, br#"{"error": "nope"}"#),
        error("unimplemented", "HTTP 404")
    );
    assert_eq!(
        read(&unary, 404, br#"{"code": 5}"#),
        error("unimplemented", "HTTP 404")
    );
}

#[test]
fn a_stream_that_started_has_no_message_of_its_own() {
    let stream = expect("stream", "json", RESPONSE);
    assert_eq!(
        read(&stream, 200, b""),
        json!({"ok": true, "message": null, "error": null})
    );
}

#[test]
fn a_rest_response_is_shown_as_it_came() {
    let rest = expect("rest", "json", RESPONSE);
    // Not the response message: `response_body` may have cut it down.
    assert_eq!(
        read(&rest, 200, br#"{"anything": [1, 2]}"#),
        json!({"ok": true, "message": {"anything": [1, 2]}, "error": null})
    );
    assert_eq!(
        read(&rest, 201, b"[]"),
        json!({"ok": true, "message": [], "error": null})
    );
    assert_eq!(
        read(&rest, 204, b""),
        json!({"ok": true, "message": {}, "error": null})
    );
    let parsed = read(&rest, 200, b"<html>");
    assert_eq!(parsed["error"]["code"], "invalid_response");
    assert!(
        parsed["error"]["message"]
            .as_str()
            .unwrap()
            .starts_with("the response is not JSON: ")
    );
}

#[test]
fn a_rest_error_is_a_status_message() {
    let rest = expect("rest", "json", RESPONSE);
    let body = json!({
        "code": 5,
        "message": "no widget w9",
        "details": [
            {"@type": "type.googleapis.com/google.rpc.ResourceInfo", "resourceName": "w9"},
            {"noType": true}
        ]
    });
    assert_eq!(
        read(&rest, 404, body.to_string().as_bytes()),
        json!({
            "ok": false,
            "message": null,
            "error": {
                "code": "not_found",
                "message": "no widget w9",
                "details": [
                    {"type": "google.rpc.ResourceInfo", "value": {"@type": "type.googleapis.com/google.rpc.ResourceInfo", "resourceName": "w9"}, "debug": null},
                    {"type": "", "value": {"noType": true}, "debug": null}
                ]
            }
        })
    );
    assert_eq!(
        read(&rest, 401, br#"{"code": 16, "message": "who?"}"#),
        error("unauthenticated", "who?")
    );
    // No body, a body that is not JSON, a code that is not one: the status.
    assert_eq!(read(&rest, 404, b""), error("http_404", "HTTP 404"));
    assert_eq!(read(&rest, 502, b"<html>"), error("http_502", "HTTP 502"));
    assert_eq!(
        read(&rest, 400, br#"{"code": 99, "message": "odd"}"#),
        error("http_400", "odd")
    );
    assert_eq!(
        read(&rest, 400, br#"{"code": "INVALID"}"#),
        error("http_400", "HTTP 400")
    );
}

fn envelope(flags: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = vec![flags];
    out.extend_from_slice(&u32::try_from(payload.len()).unwrap().to_be_bytes());
    out.extend_from_slice(payload);
    out
}

fn frames(expect: &str, buffer: &[u8]) -> Value {
    parse(&common::explorer().frames(expect, buffer).unwrap())
}

const WATCHED: &str = "fixture.v1.WatchWidgetsResponse";

#[test]
fn frames_are_read_as_far_as_the_buffer_goes() {
    let stream = expect("stream", "json", WATCHED);
    let one = envelope(0, br#"{"widget": {"id": "a"}}"#);
    let two = envelope(0, br#"{"widget": {"id": "b"}}"#);
    let end = envelope(2, br#"{"metadata": {"x-count": ["2"]}}"#);

    let mut buffer = one.clone();
    buffer.extend_from_slice(&two);
    buffer.extend_from_slice(&end);
    assert_eq!(
        frames(&stream, &buffer),
        json!({
            "consumed": buffer.len(),
            "frames": [
                {"kind": "message", "message": {"widget": {"id": "a"}}},
                {"kind": "message", "message": {"widget": {"id": "b"}}},
                {"kind": "end", "error": null, "metadata": {"x-count": ["2"]}}
            ]
        })
    );

    // A chunk that ends inside an envelope: the whole ones are read, and the
    // rest is left for the next call.
    for cut in [0, 3, 5, one.len() - 1] {
        assert_eq!(
            frames(&stream, &buffer[..cut]),
            json!({"consumed": 0, "frames": []}),
            "{cut}"
        );
    }
    let partial = frames(&stream, &buffer[..one.len() + 7]);
    assert_eq!(partial["consumed"], one.len());
    assert_eq!(partial["frames"].as_array().unwrap().len(), 1);
    // A length that claims more than any buffer holds.
    assert_eq!(
        frames(&stream, &[0, 0xff, 0xff, 0xff, 0xff, 1, 2]),
        json!({"consumed": 0, "frames": []})
    );
}

#[test]
fn binary_frames_are_decoded_too() {
    let wire = encode(&common::schema(), WATCHED, r#"{"widget": {"id": "a"}}"#).unwrap();
    assert_eq!(
        frames(&expect("stream", "proto", WATCHED), &envelope(0, &wire)),
        json!({"consumed": wire.len() + 5, "frames": [{"kind": "message", "message": {"widget": {"id": "a"}}}]})
    );
}

#[test]
fn the_end_of_a_stream_carries_the_error() {
    let stream = expect("stream", "json", WATCHED);
    let failed = envelope(2, br#"{"error": {"code": "unavailable", "message": "gone", "details": [{"type": "fixture.v1.GetWidgetRequest", "value": "CgF4"}]}}"#);
    assert_eq!(
        frames(&stream, &failed)["frames"],
        json!([{
            "kind": "end",
            "error": {"code": "unavailable", "message": "gone", "details": [{"type": "fixture.v1.GetWidgetRequest", "value": {"id": "x"}, "debug": null}]},
            "metadata": {}
        }])
    );
    // `"error": null` is no error.
    assert_eq!(
        frames(&stream, &envelope(2, br#"{"error": null}"#))["frames"],
        json!([{"kind": "end", "error": null, "metadata": {}}])
    );
    assert_eq!(
        frames(&stream, &envelope(2, b"{}"))["frames"],
        json!([{"kind": "end", "error": null, "metadata": {}}])
    );
}

#[test]
fn a_frame_that_cannot_be_read_does_not_stop_the_stream() {
    let stream = expect("stream", "json", WATCHED);
    let mut buffer = envelope(1, b"compressed");
    buffer.extend_from_slice(&envelope(0, b"not json"));
    buffer.extend_from_slice(&envelope(2, b"not json"));
    buffer.extend_from_slice(&envelope(0, br#"{"widget": {"id": "a"}}"#));
    let read = frames(&stream, &buffer);
    assert_eq!(read["consumed"], buffer.len());
    let list = read["frames"].as_array().unwrap();
    assert_eq!(
        list[0],
        json!({"kind": "invalid", "reason": "the frame is compressed, which the console did not ask for"})
    );
    assert_eq!(list[1]["kind"], "invalid");
    assert!(
        list[1]["reason"]
            .as_str()
            .unwrap()
            .starts_with("the response is not a valid message: ")
    );
    assert_eq!(list[2]["kind"], "invalid");
    assert!(
        list[2]["reason"]
            .as_str()
            .unwrap()
            .starts_with("the end of the stream is not JSON: ")
    );
    assert_eq!(
        list[3],
        json!({"kind": "message", "message": {"widget": {"id": "a"}}})
    );
}
