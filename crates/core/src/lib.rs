//! The core of wirebook: a descriptor set in, and everything the explorer
//! shows or sends out. It does no I/O and holds no state besides the schema,
//! so every answer can be tested natively, and the browser gets the same
//! code as WebAssembly.

mod auth;
mod codec;
mod curl;
mod error;
mod frames;
mod index;
mod request;
mod response;
mod rest;
mod schema;
mod scrub;
mod search;
mod template;
mod url;

use serde::Serialize;

pub use auth::{Auth, KeyLocation};
pub use codec::{Validation, decode, encode, validate};
pub use curl::curl;
pub use error::{Error, Result};
pub use frames::{Frame, Frames};
pub use index::Index;
pub use request::{
    Codec, Expect, Framing, Header, HeaderSpec, HttpRequest, RequestSpec, Transport,
};
pub use response::{Detail, Parsed, RpcError};
pub use rest::Binding;
pub use schema::Schema;
pub use scrub::{Scrubbed, scrub};
pub use search::Hit;
pub use template::template;

/// The schema with its documentation model: the one value the browser holds.
///
/// Arguments and answers that are structures cross as JSON text, which is
/// what the boundary between WebAssembly and JavaScript carries cheaply.
pub struct Explorer {
    schema: Schema,
    index: Index,
}

impl Explorer {
    /// `roots` is a JSON array of the file names the site documents; the
    /// other files of the descriptor set are its imports.
    pub fn new(image: &[u8], roots: &str) -> Result<Self> {
        let roots: Vec<String> = from_json(roots, "the list of files")?;
        let schema = Schema::load(image)?;
        let index = index::index(&schema, &roots);
        Ok(Self { schema, index })
    }

    pub fn index(&self) -> String {
        to_json(&self.index)
    }

    pub fn search(&self, query: &str, limit: usize) -> String {
        to_json(&search::search(&self.index, query, limit))
    }

    /// The example body of a message, indented for an editor.
    pub fn template(&self, message: &str) -> Result<String> {
        let value = template(&self.schema, message)?;
        Ok(serde_json::to_string_pretty(&value).unwrap_or_default())
    }

    pub fn validate(&self, message: &str, json: &str) -> Result<String> {
        validate(&self.schema, message, json).map(|validation| to_json(&validation))
    }

    /// The body without the fields marked `debug_redact`, for the history.
    pub fn scrub(&self, message: &str, json: &str) -> Result<String> {
        scrub(&self.schema, message, json).map(|scrubbed| to_json(&scrubbed))
    }

    pub fn request(&self, spec: &str) -> Result<HttpRequest> {
        request::build(
            &self.schema,
            &from_json::<RequestSpec>(spec, "the request")?,
        )
    }

    pub fn curl(&self, spec: &str, redact: bool) -> Result<String> {
        self.request(spec).map(|request| curl(&request, redact))
    }

    pub fn response(&self, expect: &str, status: u16, body: &[u8]) -> Result<String> {
        let expect: Expect = from_json(expect, "the expected response")?;
        Ok(to_json(&response::parse(
            &self.schema,
            &expect,
            status,
            body,
        )))
    }

    pub fn frames(&self, expect: &str, buffer: &[u8]) -> Result<String> {
        let expect: Expect = from_json(expect, "the expected response")?;
        Ok(to_json(&frames::decode(&self.schema, &expect, buffer)))
    }
}

fn from_json<'a, T: serde::Deserialize<'a>>(json: &'a str, what: &str) -> Result<T> {
    serde_json::from_str(json).map_err(|e| Error::new(format!("{what} is not valid: {e}")))
}

/// The values serialized here are strings, numbers and JSON values under
/// string keys; serializing them cannot fail.
pub fn to_json<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_default()
}
