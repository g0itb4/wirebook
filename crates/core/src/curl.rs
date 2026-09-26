//! The request as a curl command, to paste into a terminal or a ticket.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;

use crate::request::HttpRequest;

/// The shell variables that stand in for a secret.
const PLACEHOLDERS: [&str; 3] = ["$TOKEN", "$BASIC_CREDENTIALS", "$API_KEY"];

/// With `redact`, a credential is written as a shell variable; the command
/// can be shared, and still runs once the variable is set.
///
/// Everything else is in single quotes, where a POSIX shell (sh, bash, zsh)
/// expands nothing: a name from a proto file, a URL from an imported
/// environment or a value someone typed cannot become a second command when
/// the line is pasted.
pub fn curl(request: &HttpRequest, redact: bool) -> String {
    let mut lines = Vec::new();
    let url = if redact && request.redacted_url != request.url {
        quote_redacted(&request.redacted_url)
    } else {
        quote(&request.url)
    };
    // curl waits for a body after `-X HEAD`; `--head` is how it sends one.
    let verb = if request.verb == "HEAD" {
        "--head".to_string()
    } else if request.verb.bytes().all(|b| b.is_ascii_alphabetic()) {
        format!("-X {}", request.verb)
    } else {
        format!("-X {}", quote(&request.verb))
    };
    // --globoff: to curl, braces and brackets in a URL are a pattern, and one
    // line would become many requests.
    lines.push(format!("curl --globoff {verb} {url}"));
    for header in &request.headers {
        let line = match header.redacted.as_ref().filter(|_| redact) {
            Some(redacted) => quote_redacted(&format!("{}: {redacted}", header.name)),
            None => quote(&format!("{}: {}", header.name, header.value)),
        };
        lines.push(format!("  -H {line}"));
    }
    match (&request.body, &request.body_text) {
        (Some(body), Some(text)) if body == text.as_bytes() => {
            lines.push(format!("  --data {}", quote(text)));
        }
        // Bytes that are not text go through base64, so the command survives
        // a copy and a paste.
        (Some(body), _) => {
            lines[0] = format!(
                "echo {} | base64 --decode | {}",
                STANDARD.encode(body),
                lines[0]
            );
            lines.push("  --data-binary @-".to_string());
        }
        (None, _) => {}
    }
    lines.join(" \\\n")
}

/// Single quotes: the shell reads what is between them as it is written.
fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

/// A text that ends with the shell variable of a credential: the text in
/// single quotes, then the variable alone in double quotes, where it is
/// expanded and nothing else is.
fn quote_redacted(text: &str) -> String {
    let split = PLACEHOLDERS
        .iter()
        .find_map(|variable| Some((text.strip_suffix(variable)?, variable)));
    match split {
        Some(("", variable)) => format!("\"{variable}\""),
        Some((literal, variable)) => format!("{}\"{variable}\"", quote(literal)),
        None => quote(text),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_trailing_variable_is_left_to_the_shell() {
        assert_eq!(quote_redacted("Bearer $TOKEN"), "'Bearer '\"$TOKEN\"");
        assert_eq!(quote_redacted("$API_KEY"), "\"$API_KEY\"");
        // A variable's name inside the text is text.
        assert_eq!(quote_redacted("$TOKEN and more"), "'$TOKEN and more'");
        assert_eq!(quote_redacted("it's"), r"'it'\''s'");
    }
}
