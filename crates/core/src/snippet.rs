//! The request as a few lines of code, in languages that need nothing
//! generated: JavaScript's `fetch`, Python's `requests`, Go's `net/http`.
//!
//! Like the curl command, each is made from the built request, so it sends
//! what the console sends. Every text that someone else may have written (a
//! URL, a header, a body) is written as a string literal of the language
//! and nowhere else; a credential is read from the environment unless it is
//! asked for.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::Deserialize;

use crate::curl::{curl, split_redacted};
use crate::request::HttpRequest;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Language {
    Curl,
    Fetch,
    Python,
    Go,
}

/// How a language reads a variable of the environment, and how it escapes a
/// value for a URL.
struct Dialect {
    variable: fn(&str) -> String,
    escape: fn(&str) -> String,
    /// How two strings are joined, as the language's formatter writes it.
    plus: &'static str,
}

/// A string literal. JSON's is one in all three languages: the same quotes,
/// the same escapes.
fn literal(text: &str) -> String {
    serde_json::Value::from(text).to_string()
}

/// A text, or with `redact` its literal part joined to the credential's
/// variable. In a URL the variable is escaped, as the console escaped it.
fn value(text: &str, redacted: Option<&str>, in_url: bool, dialect: &Dialect) -> String {
    match redacted.and_then(split_redacted) {
        None => literal(text),
        Some((before, variable)) => {
            let variable = (dialect.variable)(variable.trim_start_matches('$'));
            let variable = if in_url {
                (dialect.escape)(&variable)
            } else {
                variable
            };
            if before.is_empty() {
                variable
            } else {
                format!("{}{}{variable}", literal(before), dialect.plus)
            }
        }
    }
}

struct Parts {
    verb: String,
    url: String,
    headers: Vec<(String, String)>,
    /// The body as text, or as base64 when it is not text.
    body: Option<Result<String, String>>,
    /// Whether a credential is read from the environment.
    secret: bool,
    secret_in_url: bool,
}

fn parts(request: &HttpRequest, redact: bool, dialect: &Dialect) -> Parts {
    let secret_in_url = redact && request.redacted_url != request.url;
    let headers = request.headers.iter().map(|header| {
        let redacted = header
            .redacted
            .as_ref()
            .filter(|_| redact)
            .map(|redacted| redacted.as_str());
        (
            literal(&header.name),
            value(&header.value, redacted, false, dialect),
        )
    });
    let body = request.body.as_ref().map(|body| match &request.body_text {
        Some(text) if body == text.as_bytes() => Ok(literal(text)),
        _ => Err(literal(&STANDARD.encode(body))),
    });
    Parts {
        verb: literal(&request.verb),
        url: value(
            &request.url,
            secret_in_url.then_some(request.redacted_url.as_str()),
            true,
            dialect,
        ),
        headers: headers.collect(),
        body,
        secret: redact
            && (secret_in_url
                || request
                    .headers
                    .iter()
                    .any(|header| header.redacted.is_some())),
        secret_in_url,
    }
}

pub fn snippet(request: &HttpRequest, language: Language, redact: bool) -> String {
    match language {
        Language::Curl => curl(request, redact),
        Language::Fetch => fetch(request, redact),
        Language::Python => python(request, redact),
        Language::Go => go(request, redact),
    }
}

fn fetch(request: &HttpRequest, redact: bool) -> String {
    let dialect = Dialect {
        variable: |name| format!("process.env.{name}"),
        escape: |variable| format!("encodeURIComponent({variable})"),
        plus: " + ",
    };
    let parts = parts(request, redact, &dialect);
    let mut lines = vec![
        format!("const response = await fetch({}, {{", parts.url),
        format!("  method: {},", parts.verb),
    ];
    if !parts.headers.is_empty() {
        lines.push("  headers: {".to_string());
        lines.extend(
            parts
                .headers
                .iter()
                .map(|(name, value)| format!("    {name}: {value},")),
        );
        lines.push("  },".to_string());
    }
    match parts.body {
        Some(Ok(text)) => lines.push(format!("  body: {text},")),
        Some(Err(base64)) => lines.push(format!(
            "  body: Uint8Array.from(atob({base64}), (c) => c.charCodeAt(0)),"
        )),
        None => {}
    }
    lines.push("});".to_string());
    lines.push("console.log(response.status, await response.text());".to_string());
    lines.join("\n")
}

fn python(request: &HttpRequest, redact: bool) -> String {
    let dialect = Dialect {
        variable: |name| format!("os.environ[\"{name}\"]"),
        escape: |variable| format!("urllib.parse.quote({variable}, safe=\"\")"),
        plus: " + ",
    };
    let parts = parts(request, redact, &dialect);
    let mut lines = Vec::new();
    if matches!(parts.body, Some(Err(_))) {
        lines.push("import base64".to_string());
    }
    if parts.secret {
        lines.push("import os".to_string());
    }
    if parts.secret_in_url {
        lines.push("import urllib.parse".to_string());
    }
    lines.push("import requests".to_string());
    lines.push(String::new());
    lines.push("response = requests.request(".to_string());
    lines.push(format!("    {},", parts.verb));
    lines.push(format!("    {},", parts.url));
    if !parts.headers.is_empty() {
        lines.push("    headers={".to_string());
        lines.extend(
            parts
                .headers
                .iter()
                .map(|(name, value)| format!("        {name}: {value},")),
        );
        lines.push("    },".to_string());
    }
    match parts.body {
        Some(Ok(text)) => lines.push(format!("    data={text}.encode(),")),
        Some(Err(base64)) => lines.push(format!("    data=base64.b64decode({base64}),")),
        None => {}
    }
    lines.push(")".to_string());
    lines.push("print(response.status_code, response.text)".to_string());
    lines.join("\n")
}

fn go(request: &HttpRequest, redact: bool) -> String {
    let dialect = Dialect {
        variable: |name| format!("os.Getenv(\"{name}\")"),
        escape: |variable| format!("url.QueryEscape({variable})"),
        // gofmt writes no space around an operator inside a call.
        plus: "+",
    };
    let parts = parts(request, redact, &dialect);
    let body = match &parts.body {
        Some(Ok(text)) => format!("strings.NewReader({text})"),
        Some(Err(base64)) => {
            format!("base64.NewDecoder(base64.StdEncoding, strings.NewReader({base64}))")
        }
        None => "nil".to_string(),
    };
    // Go refuses a program with an import it does not use; gofmt wants them
    // in order.
    let imports = [
        ("encoding/base64", matches!(parts.body, Some(Err(_)))),
        ("fmt", true),
        ("io", true),
        ("net/http", true),
        ("net/url", parts.secret_in_url),
        ("os", parts.secret),
        ("strings", parts.body.is_some()),
    ];
    let imports = imports.iter().filter(|(_, used)| *used);

    let mut lines = vec![
        "package main".to_string(),
        String::new(),
        "import (".to_string(),
    ];
    lines.extend(imports.map(|(import, _)| format!("\t\"{import}\"")));
    lines.push(")".to_string());
    lines.push(String::new());
    lines.push("func main() {".to_string());
    lines.push(format!(
        "\trequest, err := http.NewRequest({}, {}, {body})",
        parts.verb, parts.url
    ));
    lines.push("\tif err != nil {".to_string());
    lines.push("\t\tpanic(err)".to_string());
    lines.push("\t}".to_string());
    lines.extend(
        parts
            .headers
            .iter()
            .map(|(name, value)| format!("\trequest.Header.Set({name}, {value})")),
    );
    lines.push("\tresponse, err := http.DefaultClient.Do(request)".to_string());
    lines.push("\tif err != nil {".to_string());
    lines.push("\t\tpanic(err)".to_string());
    lines.push("\t}".to_string());
    lines.push("\tdefer response.Body.Close()".to_string());
    lines.push("\tbody, _ := io.ReadAll(response.Body)".to_string());
    lines.push("\tfmt.Println(response.Status, string(body))".to_string());
    lines.push("}".to_string());
    lines.join("\n")
}
