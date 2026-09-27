//! The codec against protobuf-go. `just golden` writes the expectations.

mod common;

use serde_json::Value;
use wirebook_core::{decode, encode};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

/// Equal as proto JSON: a number is its value, however it is written. Go
/// prints the double 1 as `1`, Rust as `1.0`.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, a)| b.get(key).is_some_and(|b| same(a, b)))
        }
        _ => a == b,
    }
}

#[test]
fn the_codec_agrees_with_protobuf_go() {
    let schema = common::schema();
    let cases = common::parse(include_str!("../../../testdata/golden/cases.json"));
    let cases = cases.as_array().unwrap();
    assert!(cases.len() >= 15, "the golden file lost its cases");
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let message = case["message"].as_str().unwrap();
        let expected = case["wire"].as_str().unwrap();

        let wire = encode(&schema, message, &case["input"].to_string()).unwrap();
        assert_eq!(hex(&wire), expected, "{name}: the wire bytes differ");

        let json = decode(&schema, message, &unhex(expected)).unwrap();
        assert!(
            same(&json, &case["json"]),
            "{name}: the JSON differs\n ours {json}\n go   {}",
            case["json"]
        );
    }
}

/// NaN is not in the golden file: Go and Rust write different bit patterns
/// for it, and both are NaN.
#[test]
fn nan_survives_a_round_trip() {
    let schema = common::schema();
    let message = "fixture.legacy.v1.Scalars";
    let wire = encode(
        &schema,
        message,
        r#"{"doubleValue":"NaN","floatValue":"NaN"}"#,
    )
    .unwrap();
    let json = decode(&schema, message, &wire).unwrap();
    assert_eq!(
        json,
        common::parse(r#"{"doubleValue":"NaN","floatValue":"NaN"}"#)
    );
}
