//! Connect streaming: every message travels in an envelope of one flag byte
//! and a four-byte big-endian length, and the stream ends with an envelope
//! whose body is JSON: the error, if any, and the trailing metadata.

use serde::Serialize;
use serde_json::{Value, json};

use crate::request::Expect;
use crate::response::{RpcError, connect_error, decode_message};
use crate::schema::Schema;

const COMPRESSED: u8 = 0b01;
const END_STREAM: u8 = 0b10;
const PREFIX: usize = 5;

/// Wrap one message for a streaming request.
pub fn envelope(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(PREFIX + payload.len());
    out.push(0);
    out.extend_from_slice(
        &u32::try_from(payload.len())
            .unwrap_or(u32::MAX)
            .to_be_bytes(),
    );
    out.extend_from_slice(payload);
    out
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Frame {
    Message {
        message: Value,
    },
    End {
        error: Option<RpcError>,
        metadata: Value,
    },
    /// An envelope the console cannot read. The stream goes on.
    Invalid {
        reason: String,
    },
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Frames {
    /// How many bytes of the buffer the frames took. The browser keeps the
    /// rest and offers it again with the next chunk.
    pub consumed: usize,
    pub frames: Vec<Frame>,
}

/// Read every whole envelope at the start of `buffer`.
pub fn decode(schema: &Schema, expect: &Expect, buffer: &[u8]) -> Frames {
    let mut frames = Vec::new();
    let mut at = 0;
    while let Some(prefix) = buffer.get(at..at + PREFIX) {
        let length = u32::from_be_bytes([prefix[1], prefix[2], prefix[3], prefix[4]]);
        let start = at + PREFIX;
        let end = usize::try_from(length)
            .ok()
            .and_then(|length| start.checked_add(length));
        let Some(payload) = end.and_then(|end| buffer.get(start..end)) else {
            break;
        };
        frames.push(frame(schema, expect, prefix[0], payload));
        at = start + payload.len();
    }
    Frames {
        consumed: at,
        frames,
    }
}

fn frame(schema: &Schema, expect: &Expect, flags: u8, payload: &[u8]) -> Frame {
    if flags & COMPRESSED != 0 {
        let reason = "the frame is compressed, which the console did not ask for".to_string();
        return Frame::Invalid { reason };
    }
    if flags & END_STREAM != 0 {
        return match serde_json::from_slice::<Value>(payload) {
            Ok(end) => Frame::End {
                error: end
                    .get("error")
                    .filter(|e| !e.is_null())
                    .map(|e| connect_error(schema, e)),
                metadata: end.get("metadata").cloned().unwrap_or(json!({})),
            },
            Err(e) => Frame::Invalid {
                reason: format!("the end of the stream is not JSON: {e}"),
            },
        };
    }
    match decode_message(schema, expect, payload) {
        Ok(message) => Frame::Message { message },
        Err(e) => Frame::Invalid {
            reason: e.to_string(),
        },
    }
}
