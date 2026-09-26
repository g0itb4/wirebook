//! A request, built whole: verb, URL, headers and body. The browser only
//! hands it to `fetch`, and the copied curl command is made from the same
//! value, so what is shown is what is sent.

use buffa_descriptor::generated::descriptor::method_options::IdempotencyLevel;
use serde::{Deserialize, Serialize};

use crate::auth::{
    Auth, KeyLocation, is_forbidden_header, is_header_value, is_sendable_method, is_token,
};
use crate::codec;
use crate::error::{Error, Result};
use crate::frames::envelope;
use crate::rest;
use crate::schema::Schema;
use crate::url::{self, Keep, append_query, percent_encode};

/// What the console asks for.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestSpec {
    /// `package.Service/Method`.
    pub method: String,
    /// The request message, as proto JSON.
    pub body: String,
    pub transport: Transport,
    pub base_url: String,
    #[serde(default)]
    pub headers: Vec<HeaderSpec>,
    #[serde(default)]
    pub auth: Auth,
    /// Which REST binding of the method, counted from 0.
    #[serde(default)]
    pub binding: usize,
    /// Sent as `Connect-Timeout-Ms`.
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HeaderSpec {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Transport {
    /// Connect over POST, the message as JSON.
    ConnectJson,
    /// Connect over POST, the message in the binary wire format.
    ConnectProto,
    /// Connect over GET, for a method without side effects.
    ConnectGet,
    /// A `google.api.http` binding.
    Rest,
}

/// How the response to a request is framed and encoded. The browser passes
/// it back, unread, with the response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Expect {
    pub framing: Framing,
    pub codec: Codec,
    /// The full name of the response message.
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Framing {
    Unary,
    Stream,
    Rest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Codec {
    Json,
    Proto,
}

impl Codec {
    fn name(self) -> &'static str {
        match self {
            Self::Json => "json",
            Self::Proto => "proto",
        }
    }
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    pub verb: String,
    pub url: String,
    /// `url`, with a credential in it replaced by a shell variable.
    pub redacted_url: String,
    pub headers: Vec<Header>,
    #[serde(skip)]
    pub body: Option<Vec<u8>>,
    /// The message as JSON, when that is what the body carries.
    pub body_text: Option<String>,
    pub expect: Expect,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Header {
    pub name: String,
    pub value: String,
    /// What a copied command shows in place of a secret `value`.
    pub redacted: Option<String>,
}

fn header(name: &str, value: impl Into<String>) -> Header {
    Header {
        name: name.to_string(),
        value: value.into(),
        redacted: None,
    }
}

pub fn build(schema: &Schema, spec: &RequestSpec) -> Result<HttpRequest> {
    let method = schema.method(&spec.method)?;
    let descriptor = method.descriptor;
    if descriptor.is_client_streaming() {
        return Err(Error::new(
            "the method takes a stream of requests, which a browser cannot send",
        ));
    }
    let stream = descriptor.is_server_streaming();
    let message = codec::from_json(schema, descriptor.input(), &spec.body)?;
    let json = codec::to_value(&message)?;
    let base = url::base(&spec.base_url)?;
    // The names come from the descriptor set. buf writes identifiers; a set
    // made by hand could hold anything, and they become part of the URL.
    let identifier = |name: &str| {
        !name.is_empty()
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.')
    };
    if !identifier(method.service) || !identifier(descriptor.name()) {
        return Err(Error::new(format!(
            "the method {:?} of {:?} is not named with identifiers, and cannot be part of a URL",
            descriptor.name(),
            method.service
        )));
    }
    let rpc = format!("{base}/{}/{}", method.service, descriptor.name());

    let mut headers = Vec::new();
    let mut body = None;
    let mut body_text = None;
    let (verb, mut url, framing, codec) = match spec.transport {
        Transport::ConnectJson | Transport::ConnectProto => {
            let codec = if spec.transport == Transport::ConnectJson {
                Codec::Json
            } else {
                Codec::Proto
            };
            let payload = match codec {
                Codec::Json => json.to_string().into_bytes(),
                Codec::Proto => codec::to_wire(&message),
            };
            if codec == Codec::Json {
                body_text = Some(json.to_string());
            }
            // A stream is a sequence of enveloped messages, the request too.
            let (framing, media, payload) = if stream {
                (Framing::Stream, "connect+", envelope(&payload))
            } else {
                (Framing::Unary, "", payload)
            };
            headers.push(header(
                "Content-Type",
                format!("application/{media}{}", codec.name()),
            ));
            headers.push(header("Connect-Protocol-Version", "1"));
            body = Some(payload);
            ("POST".to_string(), rpc, framing, codec)
        }
        Transport::ConnectGet => {
            let level = descriptor
                .options()
                .and_then(|options| options.idempotency_level);
            if stream || level != Some(IdempotencyLevel::NO_SIDE_EFFECTS) {
                return Err(Error::new(
                    "Connect allows GET only for a unary method declared with no side effects",
                ));
            }
            let mut url = rpc;
            append_query(&mut url, "connect", "v1");
            append_query(&mut url, "encoding", "json");
            append_query(
                &mut url,
                "message",
                &percent_encode(&json.to_string(), Keep::Nothing),
            );
            ("GET".to_string(), url, Framing::Unary, Codec::Json)
        }
        Transport::Rest => {
            if stream {
                return Err(Error::new(
                    "a server stream is sent over Connect, not over REST",
                ));
            }
            let bindings = rest::bindings(schema.pool(), descriptor);
            let binding = bindings.get(spec.binding).ok_or_else(|| {
                Error::new(format!(
                    "the method has no REST binding number {}",
                    spec.binding
                ))
            })?;
            // The verb comes from the proto file. It becomes the method of the
            // request and a word of the curl command, so it must be one.
            if !is_sendable_method(&binding.verb) {
                return Err(Error::new(format!(
                    "the REST binding has the method {:?}, which a browser cannot send",
                    binding.verb
                )));
            }
            let call = rest::call(schema.pool(), descriptor.input(), binding, json)?;
            let mut url = format!("{base}{}", call.path);
            for (key, value) in &call.query {
                append_query(
                    &mut url,
                    &percent_encode(key, Keep::Nothing),
                    &percent_encode(value, Keep::Nothing),
                );
            }
            if let Some(text) = call.body {
                headers.push(header("Content-Type", "application/json"));
                body = Some(text.clone().into_bytes());
                body_text = Some(text);
            }
            headers.push(header("Accept", "application/json"));
            (binding.verb.clone(), url, Framing::Rest, Codec::Json)
        }
    };
    if let (Some(timeout), true) = (spec.timeout_ms, framing != Framing::Rest) {
        headers.push(header("Connect-Timeout-Ms", timeout.to_string()));
    }

    for custom in &spec.headers {
        let (name, value) = (custom.name.trim(), custom.value.trim());
        if !is_token(name) {
            return Err(Error::new(format!("{name:?} is not a header name")));
        }
        if is_forbidden_header(name) {
            return Err(Error::new(format!(
                "a browser does not let a page set the header {name}"
            )));
        }
        if !is_header_value(value) {
            return Err(Error::new(format!(
                "the value of the header {name} must be plain ASCII text"
            )));
        }
        headers.push(header(name, value));
    }

    // Whatever built it, the URL is the base URL and then a path: one slash,
    // and not a second, which a browser reads as the start of another host.
    // The credential below is for the base URL and goes nowhere else.
    let path = &url[base.len()..];
    if !path.starts_with('/') || path.starts_with("//") {
        return Err(Error::new(format!(
            "the request would go to {url}, which is not under the base URL"
        )));
    }

    let mut redacted_url = url.clone();
    if let Some(credential) = spec.auth.credential()? {
        match credential.location {
            KeyLocation::Header => headers.push(Header {
                name: credential.name,
                value: credential.value,
                redacted: Some(credential.redacted),
            }),
            KeyLocation::Query => {
                let name = percent_encode(&credential.name, Keep::Nothing);
                append_query(
                    &mut url,
                    &name,
                    &percent_encode(&credential.value, Keep::Nothing),
                );
                append_query(&mut redacted_url, &name, &credential.redacted);
            }
        }
    }

    // A header set twice is ambiguous: which Authorization did the server see?
    for (i, one) in headers.iter().enumerate() {
        if headers[..i]
            .iter()
            .any(|other| other.name.eq_ignore_ascii_case(&one.name))
        {
            return Err(Error::new(format!("the header {} is set twice", one.name)));
        }
    }

    let message = schema
        .pool()
        .message(descriptor.output())
        .full_name()
        .to_string();
    Ok(HttpRequest {
        verb,
        url,
        redacted_url,
        headers,
        body,
        body_text,
        expect: Expect {
            framing,
            codec,
            message,
        },
    })
}
