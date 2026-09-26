//! The little of URL handling the core needs: percent-encoding, a query
//! string, and a check of the base URL.

use crate::error::{Error, Result};

/// What `percent_encode` leaves as it is, besides the unreserved characters.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Keep {
    Nothing,
    Slashes,
}

/// RFC 3986: everything but the unreserved characters is escaped.
pub fn percent_encode(text: &str, keep: Keep) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        let plain = byte.is_ascii_alphanumeric()
            || matches!(byte, b'-' | b'.' | b'_' | b'~')
            || (byte == b'/' && keep == Keep::Slashes);
        if plain {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Add `key=value` to a URL that may or may not have a query already.
pub fn append_query(url: &mut String, key: &str, value: &str) {
    url.push(if url.contains('?') { '&' } else { '?' });
    url.push_str(key);
    url.push('=');
    url.push_str(value);
}

/// The base URL of an environment: an origin, with or without a path prefix,
/// or a path on the site's own origin (the proxy). No trailing slash is kept.
///
/// A browser reads more as "another origin" than it looks: `//host` and
/// `/\host` leave this origin, and `user:password@host` puts a credential
/// where every log will keep it. None of them is accepted.
pub fn base(url: &str) -> Result<&str> {
    let url = url.trim();
    let authority = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"));
    let local = url.starts_with('/') && !url.starts_with("//");
    if authority.is_none() && !local {
        return Err(Error::new(
            "the base URL must start with http://, https:// or a single /",
        ));
    }
    if url.contains(|c: char| c.is_whitespace() || c.is_control() || matches!(c, '?' | '#' | '\\'))
    {
        return Err(Error::new(
            "the base URL must not have spaces, a backslash, a query or a fragment",
        ));
    }
    if let Some(authority) = authority {
        let host = authority.split('/').next().unwrap_or(authority);
        if host.is_empty() {
            return Err(Error::new("the base URL has no host"));
        }
        if host.contains('@') {
            return Err(Error::new(
                "the base URL must not carry a user name or a password: set them under Authentication",
            ));
        }
    }
    // "/" alone, the site's own origin, becomes "".
    Ok(url.trim_end_matches('/'))
}
