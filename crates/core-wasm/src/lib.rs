//! The core as the browser sees it. Nothing is decided here: every function
//! hands its arguments to `wirebook_core::Explorer` and its answer back.
//! Structures cross as JSON text, bytes as `Uint8Array`, and an error as a
//! JavaScript `Error` with the core's sentence as its message.

use wasm_bindgen::prelude::*;
use wirebook_core::{Error, HttpRequest};

fn js(error: Error) -> JsError {
    JsError::new(&error.to_string())
}

#[wasm_bindgen]
pub struct Explorer(wirebook_core::Explorer);

#[wasm_bindgen]
impl Explorer {
    /// `image` is the descriptor set; `roots` a JSON array of the file names
    /// the site documents.
    #[wasm_bindgen(constructor)]
    pub fn new(image: &[u8], roots: &str) -> Result<Explorer, JsError> {
        wirebook_core::Explorer::new(image, roots)
            .map(Explorer)
            .map_err(js)
    }

    pub fn index(&self) -> String {
        self.0.index()
    }

    pub fn search(&self, query: &str, limit: usize) -> String {
        self.0.search(query, limit)
    }

    pub fn template(&self, message: &str) -> Result<String, JsError> {
        self.0.template(message).map_err(js)
    }

    pub fn validate(&self, message: &str, json: &str) -> Result<String, JsError> {
        self.0.validate(message, json).map_err(js)
    }

    pub fn scrub(&self, message: &str, json: &str) -> Result<String, JsError> {
        self.0.scrub(message, json).map_err(js)
    }

    pub fn request(&self, spec: &str) -> Result<Request, JsError> {
        self.0.request(spec).map(Request).map_err(js)
    }

    pub fn curl(&self, spec: &str, redact: bool) -> Result<String, JsError> {
        self.0.curl(spec, redact).map_err(js)
    }

    pub fn response(&self, expect: &str, status: u16, body: &[u8]) -> Result<String, JsError> {
        self.0.response(expect, status, body).map_err(js)
    }

    pub fn frames(&self, expect: &str, buffer: &[u8]) -> Result<String, JsError> {
        self.0.frames(expect, buffer).map_err(js)
    }
}

/// A built request: its description as JSON, and its body as bytes.
#[wasm_bindgen]
pub struct Request(HttpRequest);

#[wasm_bindgen]
impl Request {
    /// Verb, URL, headers and what response to expect.
    pub fn describe(&self) -> String {
        wirebook_core::to_json(&self.0)
    }

    pub fn body(&self) -> Option<Vec<u8>> {
        self.0.body.clone()
    }
}
