//! Proto JSON to wire bytes and back, driven by the descriptors.

use std::sync::Arc;

use buffa_descriptor::{DynamicMessage, MessageIndex};
use serde::Serialize;
use serde_json::Value;

use crate::error::{Error, Result};
use crate::schema::Schema;

/// The verdict on a body someone typed.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Validation {
    pub ok: bool,
    /// Why the body was rejected, or "".
    pub message: String,
    /// Where, counted from 1; 0 when the body is accepted.
    pub line: usize,
    pub column: usize,
}

/// Check a JSON body against a message, as the server's parser would.
pub fn validate(schema: &Schema, message: &str, json: &str) -> Result<Validation> {
    let index = schema.message_index(message)?;
    Ok(
        match DynamicMessage::from_json(Arc::clone(schema.pool()), index, json) {
            Ok(_) => Validation {
                ok: true,
                message: String::new(),
                line: 0,
                column: 0,
            },
            Err(error) => Validation {
                ok: false,
                message: error.to_string(),
                line: error.line(),
                column: error.column(),
            },
        },
    )
}

pub(crate) fn from_json(
    schema: &Schema,
    index: MessageIndex,
    json: &str,
) -> Result<DynamicMessage> {
    DynamicMessage::from_json(Arc::clone(schema.pool()), index, json)
        .map_err(|e| Error::new(format!("the body is not a valid message: {e}")))
}

/// A response may come from a newer schema than the site was built from, so
/// a field the schema does not know is dropped, not an error.
pub(crate) fn from_json_lenient(
    schema: &Schema,
    index: MessageIndex,
    json: &str,
) -> Result<DynamicMessage> {
    DynamicMessage::from_json_ignoring_unknown(Arc::clone(schema.pool()), index, json)
        .map_err(|e| Error::new(format!("the response is not a valid message: {e}")))
}

pub(crate) fn from_wire(
    schema: &Schema,
    index: MessageIndex,
    bytes: &[u8],
) -> Result<DynamicMessage> {
    DynamicMessage::decode(Arc::clone(schema.pool()), index, bytes)
        .map_err(|e| Error::new(format!("the bytes are not a valid message: {e}")))
}

pub(crate) fn to_value(message: &DynamicMessage) -> Result<Value> {
    serde_json::to_value(message)
        .map_err(|e| Error::new(format!("the message has no JSON form: {e}")))
}

/// Encoding fails only past 2 GiB, the limit of the format. A message that
/// was typed into a page is nowhere near it.
pub(crate) fn to_wire(message: &DynamicMessage) -> Vec<u8> {
    message.encode_to_vec()
}

/// JSON in, wire bytes out.
pub fn encode(schema: &Schema, message: &str, json: &str) -> Result<Vec<u8>> {
    Ok(to_wire(&from_json(
        schema,
        schema.message_index(message)?,
        json,
    )?))
}

/// Wire bytes in, canonical JSON out.
pub fn decode(schema: &Schema, message: &str, bytes: &[u8]) -> Result<Value> {
    to_value(&from_wire(schema, schema.message_index(message)?, bytes)?)
}
