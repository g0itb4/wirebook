//! Variables of an environment: `{{name}}` in a body or a header value.
//!
//! A variable is a value that several requests share, such as the id of a
//! test tenant. It is not a secret, and it never decides where a request
//! goes: it is replaced in the body's strings and in header values, and
//! nowhere else.

use std::borrow::Cow;
use std::collections::BTreeMap;

use crate::error::{Error, Result};

pub type Variables = BTreeMap<String, String>;

/// A name a variable may have: an identifier.
pub fn is_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// Replace every `{{name}}` in `text`. Braces around anything that is not a
/// name are text and stay. A name that is not set is an error: a request
/// with a placeholder in it is not what anyone meant to send.
fn replace(text: &str, variables: &Variables, write: fn(&str) -> String) -> Result<String> {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find("{{") {
        let (before, after) = rest.split_at(open);
        out.push_str(before);
        let name = after[2..].find("}}").map(|close| &after[2..2 + close]);
        match name.map(str::trim).filter(|name| is_name(name)) {
            Some(trimmed) => {
                let value = variables.get(trimmed).ok_or_else(|| {
                    Error::new(format!(
                        "the variable {trimmed} is not set in this environment"
                    ))
                })?;
                out.push_str(&write(value));
                rest = &after[2 + name.map_or(0, str::len) + 2..];
            }
            None => {
                out.push_str("{{");
                rest = &after[2..];
            }
        }
    }
    out.push_str(rest);
    Ok(out)
}

/// In a header value: as it is.
pub fn in_text(text: &str, variables: &Variables) -> Result<String> {
    replace(text, variables, str::to_string)
}

/// In a JSON body: inside its strings only, and escaped, so a value can
/// never add a field or end the string it is in. The rest of the text is
/// left as typed, which keeps an error's line where the person sees it.
pub fn in_body<'a>(json: &'a str, variables: &Variables) -> Result<Cow<'a, str>> {
    // A value as the inside of a JSON string.
    fn escaped(value: &str) -> String {
        let quoted = serde_json::Value::from(value).to_string();
        quoted[1..quoted.len() - 1].to_string()
    }
    // A body is read at every keystroke, and most have no variable in them.
    if !json.contains("{{") {
        return Ok(Cow::Borrowed(json));
    }
    let mut out = String::with_capacity(json.len());
    let mut literal = String::new();
    let (mut in_string, mut after_backslash) = (false, false);
    for c in json.chars() {
        if !in_string {
            out.push(c);
            in_string = c == '"';
        } else if after_backslash {
            literal.push(c);
            after_backslash = false;
        } else if c == '"' {
            out.push_str(&replace(&literal, variables, escaped)?);
            out.push(c);
            literal.clear();
            in_string = false;
        } else {
            literal.push(c);
            after_backslash = c == '\\';
        }
    }
    // A string that is never closed: the parser will say so.
    out.push_str(&literal);
    Ok(Cow::Owned(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn variables() -> Variables {
        [("rackId", "r-1"), ("_n", "7"), ("quote", "a\"b\\c\nd")]
            .into_iter()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect()
    }

    #[test]
    fn a_name_is_an_identifier() {
        for name in ["a", "_", "rackId", "rack_id2", "_9"] {
            assert!(is_name(name), "{name}");
        }
        for name in ["", "9a", "a-b", "a b", "a.b", "é"] {
            assert!(!is_name(name), "{name:?}");
        }
    }

    #[test]
    fn text_is_replaced_and_what_is_not_a_variable_stays() {
        let v = variables();
        assert_eq!(in_text("x-{{rackId}}-{{ _n }}", &v).unwrap(), "x-r-1-7");
        assert_eq!(in_text("no variables", &v).unwrap(), "no variables");
        // Braces around something that is not a name are text.
        assert_eq!(
            in_text("{{}} {{a b}} {{ {{rackId}}", &v).unwrap(),
            "{{}} {{a b}} {{ r-1"
        );
        assert_eq!(in_text("open {{rackId", &v).unwrap(), "open {{rackId");
        assert_eq!(
            in_text("{{missing}}", &v).unwrap_err().to_string(),
            "the variable missing is not set in this environment"
        );
    }

    #[test]
    fn a_body_is_replaced_inside_its_strings_only() {
        let v = variables();
        assert_eq!(
            in_body(r#"{"rackId": "{{rackId}}", "n": "{{_n}}"}"#, &v).unwrap(),
            r#"{"rackId": "r-1", "n": "7"}"#
        );
        // Outside a string it is left, for the parser to refuse.
        assert_eq!(in_body(r#"{"n": {{_n}}}"#, &v).unwrap(), r#"{"n": {{_n}}}"#);
        // A value cannot end its string or add a field.
        assert_eq!(
            in_body(r#"{"a": "{{quote}}"}"#, &v).unwrap(),
            r#"{"a": "a\"b\\c\nd"}"#
        );
        // An escaped quote does not end the string it is in.
        assert_eq!(
            in_body(r#"{"a": "\"{{rackId}}\\"}"#, &v).unwrap(),
            r#"{"a": "\"r-1\\"}"#
        );
        // Lines stay where they were.
        assert_eq!(
            in_body("{\n  \"a\": \"{{rackId}}\"\n}", &v).unwrap(),
            "{\n  \"a\": \"r-1\"\n}"
        );
        assert_eq!(
            in_body(r#"{"a": "{{rackId}}"#, &v).unwrap(),
            r#"{"a": "{{rackId}}"#
        );
        assert!(in_body(r#"{"a": "{{missing}}"}"#, &v).is_err());
    }
}
