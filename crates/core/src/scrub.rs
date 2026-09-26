//! A request body without the fields its schema marks as sensitive.
//!
//! protobuf has an option for this: `[debug_redact = true]` says a field's
//! value must not be written where it could be read later, such as a log.
//! The history of calls is such a place.

use buffa_descriptor::{DescriptorPool, FieldKind, MessageIndex, SingularKind};
use serde::Serialize;
use serde_json::Value;

use crate::codec;
use crate::error::Result;
use crate::schema::Schema;

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Scrubbed {
    /// The body, indented, with every sensitive field taken out.
    pub body: String,
    /// How many fields were taken out.
    pub removed: usize,
}

pub fn scrub(schema: &Schema, message: &str, json: &str) -> Result<Scrubbed> {
    let index = schema.message_index(message)?;
    let mut value = codec::to_value(&codec::from_json(schema, index, json)?)?;
    let mut removed = 0;
    walk(schema.pool(), index, &mut value, &mut removed);
    let body = serde_json::to_string_pretty(&value).unwrap_or_default();
    Ok(Scrubbed { body, removed })
}

fn walk(pool: &DescriptorPool, index: MessageIndex, value: &mut Value, removed: &mut usize) {
    let descriptor = pool.message(index);
    if descriptor.full_name() == "google.protobuf.Any" {
        // An Any is written with the fields of the message it holds.
        let held = value["@type"]
            .as_str()
            .and_then(|url| pool.message_index(url.rsplit('/').next().unwrap_or(url)));
        if let Some(held) = held {
            walk(pool, held, value, removed);
        }
        return;
    }
    // The other well-known types are not written with their own fields.
    let own_fields = !descriptor.full_name().starts_with("google.protobuf.");
    let Some(object) = value.as_object_mut().filter(|_| own_fields) else {
        return;
    };
    for field in descriptor.fields() {
        if field.options().and_then(|options| options.debug_redact) == Some(true) {
            *removed += usize::from(object.shift_remove(field.json_name()).is_some());
            continue;
        }
        let (element, map) = match field.kind() {
            FieldKind::Singular(element) | FieldKind::List(element) => (element, false),
            FieldKind::Map { value, .. } => (value, true),
        };
        let (SingularKind::Message(inner), Some(held)) =
            (element, object.get_mut(field.json_name()))
        else {
            continue;
        };
        match held {
            Value::Array(items) => {
                items
                    .iter_mut()
                    .for_each(|item| walk(pool, inner, item, removed));
            }
            Value::Object(entries) if map => {
                entries
                    .values_mut()
                    .for_each(|entry| walk(pool, inner, entry, removed));
            }
            single => walk(pool, inner, single, removed),
        }
    }
}
