//! The authentication schemes the console offers: none, Bearer, Basic and an
//! API key. Each one becomes a header or a query parameter of the request.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::Deserialize;

use crate::error::{Error, Result};

#[derive(Debug, Default, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "scheme", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Auth {
    #[default]
    None,
    /// `Authorization: Bearer <token>`. A JWT or an OAuth2 access token.
    Bearer { token: String },
    /// `Authorization: Basic base64(username:password)`, RFC 7617.
    Basic { username: String, password: String },
    /// A key in a named header or a named query parameter.
    #[serde(rename_all = "camelCase")]
    ApiKey {
        #[serde(default = "default_key_name")]
        name: String,
        value: String,
        #[serde(default)]
        location: KeyLocation,
    },
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum KeyLocation {
    #[default]
    Header,
    Query,
}

fn default_key_name() -> String {
    "X-API-Key".to_string()
}

/// A credential, placed. `redacted` is what a copied command shows in place
/// of `value`: a shell variable, never the secret.
#[derive(Debug, PartialEq, Eq)]
pub struct Credential {
    pub location: KeyLocation,
    pub name: String,
    pub value: String,
    pub redacted: String,
}

impl Auth {
    /// Where the credential goes, or `None` when there is none to send.
    pub fn credential(&self) -> Result<Option<Credential>> {
        let header = |value: String, redacted: &str| Credential {
            location: KeyLocation::Header,
            name: "Authorization".to_string(),
            value,
            redacted: redacted.to_string(),
        };
        Ok(Some(match self {
            Self::None => return Ok(None),
            Self::Bearer { token } => {
                let token = token.trim();
                if token.is_empty() || !token.chars().all(|c| c.is_ascii_graphic()) {
                    return Err(Error::new(
                        "the bearer token must be one word, and not empty",
                    ));
                }
                header(format!("Bearer {token}"), "Bearer $TOKEN")
            }
            Self::Basic { username, password } => {
                // RFC 7617: the first colon ends the user name.
                if username.is_empty() || username.contains(':') {
                    return Err(Error::new(
                        "the user name must not be empty or contain a colon",
                    ));
                }
                if format!("{username}{password}").contains(|c: char| c.is_control()) {
                    return Err(Error::new(
                        "the user name and password must not contain control characters",
                    ));
                }
                let encoded = STANDARD.encode(format!("{username}:{password}"));
                header(format!("Basic {encoded}"), "Basic $BASIC_CREDENTIALS")
            }
            Self::ApiKey {
                name,
                value,
                location,
            } => {
                if value.is_empty() || !is_header_value(value) {
                    return Err(Error::new(
                        "the API key must be plain ASCII text, and not empty",
                    ));
                }
                if !is_token(name) {
                    return Err(Error::new(
                        "the API key name must be a header or parameter name",
                    ));
                }
                if *location == KeyLocation::Header && is_forbidden_header(name) {
                    return Err(Error::new(format!(
                        "a browser does not let a page set the header {name}"
                    )));
                }
                Credential {
                    location: *location,
                    name: name.clone(),
                    value: value.clone(),
                    redacted: "$API_KEY".to_string(),
                }
            }
        }))
    }
}

/// An HTTP token, RFC 9110: the characters a header name is made of.
pub fn is_token(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
}

/// What a header value may hold here: visible ASCII and spaces. `fetch`
/// refuses anything a byte cannot carry, with an error that reads like a
/// network failure; this one says what is wrong.
pub fn is_header_value(value: &str) -> bool {
    value.chars().all(|c| (' '..='~').contains(&c))
}

/// The headers a browser sets itself. A page that sets one is ignored without
/// a word, so the request shown would not be the request sent.
pub fn is_forbidden_header(name: &str) -> bool {
    const NAMES: [&str; 21] = [
        "accept-charset",
        "accept-encoding",
        "access-control-request-headers",
        "access-control-request-method",
        "connection",
        "content-length",
        "cookie",
        "cookie2",
        "date",
        "dnt",
        "expect",
        "host",
        "keep-alive",
        "origin",
        "referer",
        "set-cookie",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "via",
    ];
    let name = name.to_ascii_lowercase();
    NAMES.contains(&name.as_str()) || name.starts_with("proxy-") || name.starts_with("sec-")
}

/// The methods `fetch` sends. It refuses the three that tunnel or echo, and
/// anything that is not a token.
pub fn is_sendable_method(verb: &str) -> bool {
    let upper = verb.to_ascii_uppercase();
    is_token(verb) && !matches!(upper.as_str(), "CONNECT" | "TRACE" | "TRACK")
}
