//! A response, read: the message as JSON, or the error with its details
//! decoded through the schema.

use base64::Engine;
use base64::engine::general_purpose::STANDARD_NO_PAD;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::codec;
use crate::error::{Error, Result};
use crate::request::{Codec, Expect, Framing};
use crate::schema::Schema;

#[derive(Debug, PartialEq, Serialize)]
pub struct Parsed {
    pub ok: bool,
    /// The response message. `None` on an error, and for a stream, whose
    /// messages arrive as frames.
    pub message: Option<Value>,
    pub error: Option<RpcError>,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct RpcError {
    /// A Connect code such as `not_found`; `http_404` when a REST server
    /// sent no error body; `invalid_response` when the console could not
    /// read what came back.
    pub code: String,
    pub message: String,
    pub details: Vec<Detail>,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Detail {
    /// The full name of the detail's message type.
    pub r#type: String,
    /// The detail as JSON, when the schema knows its type.
    pub value: Option<Value>,
    pub debug: Option<Value>,
}

pub fn parse(schema: &Schema, expect: &Expect, status: u16, body: &[u8]) -> Parsed {
    let unreadable = |e: Error| RpcError {
        code: "invalid_response".to_string(),
        message: e.to_string(),
        details: Vec::new(),
    };
    let outcome = match (expect.framing, status) {
        (Framing::Unary, 200) => decode_message(schema, expect, body)
            .map(Some)
            .map_err(unreadable),
        (Framing::Rest, 200..=299) => rest_body(body).map(Some).map_err(unreadable),
        // The frames of a stream are read as they arrive, by `frames::decode`.
        (Framing::Stream, 200) => Ok(None),
        (Framing::Rest, _) => Err(rest_error(status, body)),
        _ => Err(http_error(schema, status, body)),
    };
    match outcome {
        Ok(message) => Parsed {
            ok: true,
            message,
            error: None,
        },
        Err(error) => Parsed {
            ok: false,
            message: None,
            error: Some(error),
        },
    }
}

pub(crate) fn decode_message(schema: &Schema, expect: &Expect, body: &[u8]) -> Result<Value> {
    let index = schema.message_index(&expect.message)?;
    let message = match expect.codec {
        Codec::Json => {
            let text = std::str::from_utf8(body)
                .map_err(|e| Error::new(format!("the response is not UTF-8: {e}")))?;
            codec::from_json_lenient(schema, index, text)?
        }
        Codec::Proto => codec::from_wire(schema, index, body)?,
    };
    codec::to_value(&message)
}

/// A REST body is shown as it came: `response_body` in the rule may have cut
/// it down to one field, so it is not always the response message.
fn rest_body(body: &[u8]) -> Result<Value> {
    if body.is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    serde_json::from_slice(body).map_err(|e| Error::new(format!("the response is not JSON: {e}")))
}

/// A Connect error is a JSON object on any status but 200. When the body is
/// something else, a proxy answered, and the status is all there is.
fn http_error(schema: &Schema, status: u16, body: &[u8]) -> RpcError {
    match serde_json::from_slice::<Value>(body) {
        Ok(error) if error["code"].is_string() => connect_error(schema, &error),
        _ => RpcError {
            code: connect_code(status).to_string(),
            message: format!("HTTP {status}"),
            details: Vec::new(),
        },
    }
}

/// The table of the Connect protocol, for a response that is not a Connect
/// error.
fn connect_code(status: u16) -> &'static str {
    match status {
        400 => "internal",
        401 => "unauthenticated",
        403 => "permission_denied",
        404 => "unimplemented",
        429 | 502 | 503 | 504 => "unavailable",
        _ => "unknown",
    }
}

pub(crate) fn connect_error(schema: &Schema, error: &Value) -> RpcError {
    let details = error["details"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|detail| {
            let r#type = detail["type"].as_str().unwrap_or("").to_string();
            // Connect sends the detail as unpadded base64 of the wire bytes.
            let value = detail["value"]
                .as_str()
                .and_then(|text| STANDARD_NO_PAD.decode(text.trim_end_matches('=')).ok())
                .and_then(|bytes| codec::decode(schema, &r#type, &bytes).ok());
            Detail {
                r#type,
                value,
                debug: detail.get("debug").cloned(),
            }
        });
    RpcError {
        code: error["code"].as_str().unwrap_or("unknown").to_string(),
        message: error["message"].as_str().unwrap_or("").to_string(),
        details: details.collect(),
    }
}

const RPC_CODES: [&str; 17] = [
    "ok",
    "canceled",
    "unknown",
    "invalid_argument",
    "deadline_exceeded",
    "not_found",
    "already_exists",
    "permission_denied",
    "resource_exhausted",
    "failed_precondition",
    "aborted",
    "out_of_range",
    "unimplemented",
    "internal",
    "unavailable",
    "data_loss",
    "unauthenticated",
];

/// A REST error is a `google.rpc.Status` as JSON: a numeric code, a message,
/// and details that are `Any` messages, already JSON.
fn rest_error(status: u16, body: &[u8]) -> RpcError {
    let error = serde_json::from_slice::<Value>(body).unwrap_or(Value::Null);
    let number = error["code"].as_u64();
    let code = (0u64..)
        .zip(RPC_CODES)
        .find(|(index, _)| Some(*index) == number)
        .map_or_else(|| format!("http_{status}"), |(_, code)| code.to_string());
    let details = error["details"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|detail| {
            let url = detail["@type"].as_str().unwrap_or("");
            Detail {
                r#type: url.rsplit('/').next().unwrap_or(url).to_string(),
                value: Some(detail.clone()),
                debug: None,
            }
        });
    RpcError {
        code,
        message: error["message"]
            .as_str()
            .map_or_else(|| format!("HTTP {status}"), str::to_string),
        details: details.collect(),
    }
}
