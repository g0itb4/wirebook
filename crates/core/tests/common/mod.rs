#![allow(dead_code)]

use serde_json::Value;
use wirebook_core::{Explorer, Schema};

pub const IMAGE: &[u8] = include_bytes!("../../../../testdata/fixture.binpb");

/// The four fixture files; everything else in the image is an import.
pub const ROOTS: &str = r#"[
    "fixture/v1/editions.proto",
    "fixture/v1/library.proto",
    "fixture/legacy/v1/proto3.proto",
    "fixture/legacy/v1/proto2.proto"
]"#;

pub fn schema() -> Schema {
    Schema::load(IMAGE).unwrap()
}

pub fn explorer() -> Explorer {
    Explorer::new(IMAGE, ROOTS).unwrap()
}

pub fn parse(json: &str) -> Value {
    serde_json::from_str(json).unwrap()
}

/// The element of an array whose `name` is `name`.
pub fn named<'a>(list: &'a Value, name: &str) -> &'a Value {
    list.as_array()
        .unwrap()
        .iter()
        .find(|item| item["name"] == name)
        .unwrap_or_else(|| panic!("nothing is named {name}"))
}
