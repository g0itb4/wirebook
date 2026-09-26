//! An example body for a message: every field present, at its zero value,
//! so the person at the console edits values instead of typing names.

use buffa_descriptor::{DescriptorPool, FieldKind, MessageIndex, ScalarType, SingularKind};
use serde_json::{Map, Value, json};

use crate::error::Result;
use crate::schema::Schema;

/// The example body of `message`, as canonical proto JSON that the codec
/// accepts.
pub fn template(schema: &Schema, message: &str) -> Result<Value> {
    let index = schema.message_index(message)?;
    Ok(of_message(schema.pool(), index, &mut Vec::new()).unwrap_or(json!({})))
}

/// `None` for a message with no useful example: `Any`, whose body depends on
/// a type the template cannot choose, and a message already being built
/// further up, which would never end.
fn of_message(
    pool: &DescriptorPool,
    index: MessageIndex,
    open: &mut Vec<MessageIndex>,
) -> Option<Value> {
    let descriptor = pool.message(index);
    if let Some(known) = well_known(descriptor.full_name()) {
        return known;
    }
    if open.contains(&index) {
        return None;
    }
    open.push(index);
    let mut out = Map::new();
    let mut oneofs = Vec::new();
    for field in descriptor.fields() {
        // Of a oneof, only the first member: two would be rejected.
        let oneof = field.oneof_index().filter(|i| {
            descriptor
                .oneofs()
                .get(usize::from(*i))
                .is_some_and(|oneof| !oneof.is_synthetic())
        });
        if oneof.is_some_and(|i| oneofs.contains(&i)) {
            continue;
        }
        oneofs.extend(oneof);
        let value = match field.kind() {
            FieldKind::Singular(element) => of_element(pool, element, open),
            FieldKind::List(element) => Some(Value::Array(
                of_element(pool, element, open).into_iter().collect(),
            )),
            FieldKind::Map { key, value } => {
                let entry =
                    of_element(pool, value, open).map(|value| (map_key(key).to_string(), value));
                Some(Value::Object(entry.into_iter().collect()))
            }
        };
        if let Some(value) = value {
            out.insert(field.json_name().to_string(), value);
        }
    }
    open.pop();
    Some(Value::Object(out))
}

fn of_element(
    pool: &DescriptorPool,
    element: SingularKind,
    open: &mut Vec<MessageIndex>,
) -> Option<Value> {
    match element {
        SingularKind::Scalar(scalar) => Some(of_scalar(scalar)),
        SingularKind::Enum(index) => pool
            .enumeration(index)
            .values()
            .first()
            .map(|value| json!(value.name())),
        SingularKind::Message(index) => of_message(pool, index, open),
    }
}

/// 64-bit integers are strings in proto JSON; bytes are base64.
fn of_scalar(scalar: ScalarType) -> Value {
    match scalar {
        ScalarType::String | ScalarType::Bytes => json!(""),
        ScalarType::Bool => json!(false),
        ScalarType::Int64
        | ScalarType::Uint64
        | ScalarType::Fixed64
        | ScalarType::Sfixed64
        | ScalarType::Sint64 => json!("0"),
        _ => json!(0),
    }
}

fn map_key(scalar: ScalarType) -> &'static str {
    match scalar {
        ScalarType::String => "key",
        ScalarType::Bool => "false",
        _ => "0",
    }
}

/// The well-known types have their own JSON forms. The outer `Option` says
/// whether the message is one of them.
fn well_known(name: &str) -> Option<Option<Value>> {
    let value = match name.strip_prefix("google.protobuf.")? {
        "Any" => return Some(None),
        "Timestamp" => json!("1970-01-01T00:00:00Z"),
        "Duration" => json!("0s"),
        "FieldMask" | "StringValue" | "BytesValue" => json!(""),
        "Struct" | "Empty" => json!({}),
        "Value" => Value::Null,
        "ListValue" => json!([]),
        "DoubleValue" | "FloatValue" | "Int32Value" | "UInt32Value" => json!(0),
        "Int64Value" | "UInt64Value" => json!("0"),
        "BoolValue" => json!(false),
        _ => return None,
    };
    Some(Some(value))
}
