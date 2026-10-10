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
mod reference;
mod request;
mod response;
mod rest;
mod rules;
mod schema;
mod scrub;
mod search;
mod snippet;
mod template;
mod url;
mod vars;

use serde::Serialize;
use serde_json::Value;

pub use auth::{Auth, KeyLocation};
pub use codec::{Validation, decode, encode, validate};
pub use curl::curl;
pub use error::{Error, Result};
pub use frames::{Frame, Frames};
pub use index::{Index, Options};
pub use reference::{Catalog, Reference};
pub use request::{
    Codec, Expect, Framing, Header, HeaderSpec, HttpRequest, RequestSpec, Transport,
};
pub use response::{Detail, Parsed, RpcError};
pub use rest::Binding;
pub use rules::Violation;
pub use schema::Schema;
pub use scrub::{Scrubbed, scrub};
pub use search::Hit;
pub use snippet::{Language, snippet};
pub use template::template;
pub use vars::Variables;

/// The schema with its documentation model: the one value the browser holds.
///
/// Arguments and answers that are structures cross as JSON text, which is
/// what the boundary between WebAssembly and JavaScript carries cheaply.
pub struct Explorer {
    schema: Schema,
    catalog: Catalog,
    index: Index,
}

impl Explorer {
    /// `options` is a JSON object: `roots`, the file names the site
    /// documents, and `lookups`, the lists the config names for fields.
    pub fn new(image: &[u8], options: &str) -> Result<Self> {
        let options: Options = from_json(options, "the options object")?;
        let schema = Schema::load(image)?;
        let catalog = Catalog::new(&schema);
        let index = index::index(&schema, &catalog, &options);
        Ok(Self {
            schema,
            catalog,
            index,
        })
    }

    pub fn index(&self) -> String {
        to_json(&self.index)
    }

    pub fn search(&self, query: &str, limit: usize) -> String {
        to_json(&search::search(&self.index, query, limit))
    }

    /// The example body of a message, indented for an editor. `variables`
    /// is a JSON object of the environment's variables.
    pub fn template(&self, message: &str, variables: &str) -> Result<String> {
        let variables: Variables = from_json(variables, "the variables object")?;
        let value = template(&self.schema, message, &variables)?;
        Ok(serde_json::to_string_pretty(&value).unwrap_or_default())
    }

    /// Whether a typed body is one the message accepts, once its variables
    /// are replaced.
    pub fn validate(&self, message: &str, json: &str, variables: &str) -> Result<String> {
        let variables: Variables = from_json(variables, "the variables object")?;
        let validation = match vars::in_body(json, &variables) {
            Ok(body) => validate(&self.schema, message, &body)?,
            Err(error) => Validation {
                ok: false,
                message: error.to_string(),
                line: 1,
                column: 1,
            },
        };
        Ok(to_json(&validation))
    }

    /// The rules of the schema that a body does not meet. A body that is
    /// not valid has none to report: `validate` says what is wrong with it.
    pub fn check(&self, message: &str, json: &str, variables: &str) -> Result<String> {
        let variables: Variables = from_json(variables, "the variables object")?;
        let index = self.schema.message_index(message)?;
        let body = vars::in_body(json, &variables)
            .and_then(|body| codec::from_json(&self.schema, index, &body))
            .and_then(|message| codec::to_value(&message));
        let violations = body.map_or_else(
            |_| Vec::new(),
            |body| rules::check(&self.schema, index, &body),
        );
        Ok(to_json(&violations))
    }

    /// The body without the fields marked `debug_redact`, for the history.
    pub fn scrub(&self, message: &str, json: &str, variables: &str) -> Result<String> {
        let variables: Variables = from_json(variables, "the variables object")?;
        let body = vars::in_body(json, &variables)?;
        scrub(&self.schema, message, &body).map(|scrubbed| to_json(&scrubbed))
    }

    pub fn request(&self, spec: &str) -> Result<HttpRequest> {
        request::build(
            &self.schema,
            &from_json::<RequestSpec>(spec, "the request")?,
        )
    }

    /// The request as code: `curl`, `fetch`, `python` or `go`.
    pub fn snippet(&self, spec: &str, language: &str, redact: bool) -> Result<String> {
        let language: Language = from_json(&to_json(&language), "the language")?;
        self.request(spec)
            .map(|request| snippet(&request, language, redact))
    }

    pub fn curl(&self, spec: &str, redact: bool) -> Result<String> {
        self.snippet(spec, "curl", redact)
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

    /// The list a field's value is picked from. `field` is
    /// `package.Message.field`.
    fn reference(&self, field: &str) -> Result<&Reference> {
        let found = field.rsplit_once('.').and_then(|(message, name)| {
            let message = self.index.messages.iter().find(|doc| doc.name == message)?;
            message
                .fields
                .iter()
                .find(|doc| doc.name == name)?
                .reference
                .as_ref()
        });
        found.ok_or_else(|| Error::new(format!("the field {field} has no list to pick from")))
    }

    /// The request that lists the resource a field refers to, as a method
    /// and a body. `context` is a JSON object of what is known: the fields
    /// around the one being picked, by JSON name.
    pub fn lookup_request(&self, field: &str, context: &str, page_token: &str) -> Result<String> {
        let context: Value = from_json(context, "the context")?;
        reference::request(self.reference(field)?, &context, page_token).map(|plan| to_json(&plan))
    }

    /// The ids and labels in the response of that list.
    pub fn lookup_read(&self, field: &str, response: &str) -> Result<String> {
        let response: Value = from_json(response, "the response")?;
        Ok(to_json(&reference::read(self.reference(field)?, &response)))
    }

    /// The ids of resources in a response message, wherever they are in it.
    pub fn seen(&self, message: &str, response: &str) -> Result<String> {
        let response: Value = from_json(response, "the response")?;
        let mut out = Vec::new();
        self.catalog.seen(
            &self.schema,
            self.schema.message_index(message)?,
            &response,
            &mut out,
        );
        Ok(to_json(&out))
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
