//! `google.api.http`: the REST bindings of a method, and the request one of
//! them makes from a message.
//!
//! The rules are those of google/api/http.proto: a path variable takes its
//! value from a field of the request; `body` names the field sent as the
//! body, or `*` for every field left; whatever is in neither becomes a query
//! parameter.

use std::sync::Arc;

use buffa_descriptor::{
    DescriptorPool, DynamicMessage, FieldKind, MessageIndex, MethodDescriptor, SingularKind,
};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::error::{Error, Result};
use crate::url::{Keep, percent_encode};

/// One way to call a method over REST.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Binding {
    pub verb: String,
    pub path: String,
    pub body: String,
}

/// What a binding makes of a request message.
#[derive(Debug, PartialEq, Eq)]
pub struct Call {
    pub path: String,
    pub query: Vec<(String, String)>,
    pub body: Option<String>,
}

/// The bindings of a method, the primary one first.
///
/// The rule is a custom option. It can be read only when the descriptor set
/// carries `descriptor.proto` and `google/api/http.proto`, which it does
/// whenever a file imports `google/api/annotations.proto`.
pub fn bindings(pool: &Arc<DescriptorPool>, method: &MethodDescriptor) -> Vec<Binding> {
    let rule = method
        .options()
        .and_then(|options| DynamicMessage::from_options(Arc::clone(pool), options))
        .and_then(|options| options.to_json().ok())
        .and_then(|json| serde_json::from_str::<Value>(&json).ok())
        .and_then(|mut options| options.get_mut("[google.api.http]").map(Value::take));
    let mut out = Vec::new();
    if let Some(rule) = rule {
        push(&rule, &mut out);
        for extra in rule["additionalBindings"].as_array().into_iter().flatten() {
            push(extra, &mut out);
        }
    }
    out
}

fn push(rule: &Value, out: &mut Vec<Binding>) {
    let body = rule["body"].as_str().unwrap_or("");
    let pattern = ["get", "put", "post", "delete", "patch"]
        .into_iter()
        .find_map(|verb| rule[verb].as_str().map(|path| (verb.to_uppercase(), path)))
        .or_else(|| {
            let custom = &rule["custom"];
            Some((
                custom["kind"].as_str()?.to_string(),
                custom["path"].as_str()?,
            ))
        });
    if let Some((verb, path)) = pattern {
        out.push(Binding {
            verb,
            path: path.to_string(),
            body: body.to_string(),
        });
    }
}

/// Split a request message, as canonical JSON, between the path, the query
/// and the body of a binding.
pub fn call(
    pool: &DescriptorPool,
    input: MessageIndex,
    binding: &Binding,
    mut message: Value,
) -> Result<Call> {
    let path = expand(pool, input, &binding.path, &mut message)?;
    let body = match binding.body.as_str() {
        "" => None,
        "*" => Some(std::mem::take(&mut message)),
        field => {
            let descriptor = pool
                .message(input)
                .field_by_name(field)
                .ok_or_else(|| Error::new(format!("the request has no field {field}")))?;
            let value = message
                .as_object_mut()
                .and_then(|fields| fields.shift_remove(descriptor.json_name()));
            // A body field that is not set is sent as an empty message.
            Some(value.unwrap_or(Value::Object(Map::new())))
        }
    };
    let mut query = Vec::new();
    if message.is_object() {
        flatten(pool, input, &message, "", &mut query)?;
    }
    Ok(Call {
        path,
        query,
        body: body.map(|body| body.to_string()),
    })
}

fn expand(
    pool: &DescriptorPool,
    input: MessageIndex,
    template: &str,
    message: &mut Value,
) -> Result<String> {
    // The template comes from the proto file and is joined to the base URL.
    // Only a path keeps the request on the host of the base URL: a template
    // that starts with anything else (".evil.example/", ":8443/", "@host/")
    // would name another.
    let not_a_path = !template.starts_with('/')
        || template.contains(|c: char| {
            c.is_whitespace() || c.is_control() || matches!(c, '\\' | '?' | '#')
        });
    if not_a_path {
        return Err(Error::new(format!(
            "the path template {template:?} is not a path: it must start with / and have no query, fragment, backslash or space"
        )));
    }
    let mut out = String::new();
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        let (literal, after) = rest.split_at(open);
        out.push_str(checked(literal, template)?);
        let close = after.find('}').ok_or_else(|| {
            Error::new(format!(
                "the path template {template} has a variable that is not closed"
            ))
        })?;
        let variable = &after[1..close];
        let (field, pattern) = variable.split_once('=').unwrap_or((variable, "*"));
        let value = take(pool, input, message, field, field)?;
        let value = scalar(&value)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                Error::new(format!(
                    "the path variable {field} needs a value that is not empty"
                ))
            })?;
        // A pattern of several segments matches a value with slashes in it,
        // such as a resource name; they are part of the path.
        let keep = if pattern.contains('/') || pattern.contains("**") {
            Keep::Slashes
        } else {
            Keep::Nothing
        };
        // A browser resolves "." and ".." before it sends, escaped or not:
        // the request would go to another path than the one shown.
        let dots = |segment: &str| segment == "." || segment == "..";
        if dots(&value) || (keep == Keep::Slashes && value.split('/').any(dots)) {
            return Err(Error::new(format!(
                "the path variable {field} must not be \".\" or \"..\", which a URL reads as a directory"
            )));
        }
        out.push_str(&percent_encode(&value, keep));
        rest = &after[close + 1..];
    }
    out.push_str(checked(rest, template)?);
    Ok(out)
}

fn checked<'a>(literal: &'a str, template: &str) -> Result<&'a str> {
    if literal.contains('*') {
        return Err(Error::new(format!(
            "the path template {template} has a wildcard outside a variable, which nothing can fill"
        )));
    }
    Ok(literal)
}

/// Remove the field at a dotted path of proto field names, and return it.
fn take(
    pool: &DescriptorPool,
    message: MessageIndex,
    at: &mut Value,
    path: &str,
    whole: &str,
) -> Result<Value> {
    let unknown = || Error::new(format!("the request has no field {whole}"));
    let missing = || {
        Error::new(format!(
            "the field {whole} has no value in the request body"
        ))
    };
    let (head, tail) = path
        .split_once('.')
        .map_or((path, None), |(head, tail)| (head, Some(tail)));
    let field = pool
        .message(message)
        .field_by_name(head)
        .ok_or_else(unknown)?;
    let object = at.as_object_mut().ok_or_else(missing)?;
    match (tail, field.kind()) {
        (None, _) => object.shift_remove(field.json_name()).ok_or_else(missing),
        (Some(tail), FieldKind::Singular(SingularKind::Message(next))) => {
            let inner = object.get_mut(field.json_name()).ok_or_else(missing)?;
            take(pool, next, inner, tail, whole)
        }
        (Some(_), _) => Err(unknown()),
    }
}

fn scalar(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

/// Query parameters are named by proto field name, nested fields joined by
/// dots. A map or a repeated message has no query form.
fn flatten(
    pool: &DescriptorPool,
    message: MessageIndex,
    value: &Value,
    prefix: &str,
    out: &mut Vec<(String, String)>,
) -> Result<()> {
    for field in pool.message(message).fields() {
        let Some(value) = value.get(field.json_name()) else {
            continue;
        };
        let name = format!("{prefix}{}", field.name());
        let unfit = || {
            Error::new(format!(
                "the field {name} cannot be sent as a query parameter"
            ))
        };
        match (field.kind(), value) {
            (FieldKind::Map { .. }, _) => return Err(unfit()),
            (FieldKind::List(_), Value::Array(items)) => {
                for item in items {
                    out.push((name.clone(), scalar(item).ok_or_else(unfit)?));
                }
            }
            (FieldKind::Singular(SingularKind::Message(inner)), Value::Object(_)) => {
                // A well-known type that is an object in JSON (a Struct, an
                // Any) is not written with the fields of its message.
                if pool
                    .message(inner)
                    .full_name()
                    .starts_with("google.protobuf.")
                {
                    return Err(unfit());
                }
                flatten(pool, inner, value, &format!("{name}."), out)?;
            }
            _ => out.push((name.clone(), scalar(value).ok_or_else(unfit)?)),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    //! Templates that no fixture method has: a malformed one, and a variable
    //! that points where no field is. The rest is tested through requests.

    use serde_json::json;

    use super::*;
    use crate::schema::Schema;

    const IMAGE: &[u8] = include_bytes!("../../../testdata/fixture.binpb");

    fn call_with(input: &str, path: &str, body: &str, message: Value) -> Result<Call> {
        let schema = Schema::load(IMAGE).unwrap();
        let input = schema.message_index(input).unwrap();
        let binding = Binding {
            verb: "POST".to_string(),
            path: path.to_string(),
            body: body.to_string(),
        };
        call(schema.pool(), input, &binding, message)
    }

    fn update_book(path: &str, body: &str, message: Value) -> Result<Call> {
        call_with("fixture.v1.UpdateBookRequest", path, body, message)
    }

    fn refused(path: &str, body: &str, message: Value) -> String {
        update_book(path, body, message).unwrap_err().to_string()
    }

    #[test]
    fn a_malformed_template_is_refused() {
        let book = json!({"book": {"name": "n"}});
        assert_eq!(
            refused("/v1/{book.name", "", book.clone()),
            "the path template /v1/{book.name has a variable that is not closed"
        );
        for path in ["/v1/*/books/{book.name}", "/v1/{book.name}/**"] {
            assert_eq!(
                refused(path, "", book.clone()),
                format!(
                    "the path template {path} has a wildcard outside a variable, which nothing can fill"
                )
            );
        }
    }

    #[test]
    fn a_variable_must_name_a_field_that_has_a_scalar_value() {
        let book = json!({"book": {"name": "n", "author": {"familyName": "f"}, "publishTime": "2020-01-01T00:00:00Z", "genres": ["a"]}});
        assert_eq!(
            refused("/v1/{nope}", "", book.clone()),
            "the request has no field nope"
        );
        assert_eq!(
            refused("/v1/{book.nope}", "", book.clone()),
            "the request has no field book.nope"
        );
        // `name` is a string: nothing lies under it.
        assert_eq!(
            refused("/v1/{book.name.x}", "", book.clone()),
            "the request has no field book.name.x"
        );
        // A timestamp is a message in the schema and a string in JSON.
        assert_eq!(
            refused("/v1/{book.publish_time.seconds}", "", book.clone()),
            "the field book.publish_time.seconds has no value in the request body"
        );
        // A message and a list are not values of a path segment.
        for field in ["book.author", "book.genres"] {
            assert_eq!(
                refused(&format!("/v1/{{{field}}}"), "", book.clone()),
                format!("the path variable {field} needs a value that is not empty")
            );
        }
        assert_eq!(
            refused("/v1/x", "nope", book),
            "the request has no field nope"
        );
    }

    #[test]
    fn numbers_and_flags_fill_a_path_and_a_query() {
        let message = json!({"book": {"name": "n", "pages": 12}});
        let call = update_book("/v1/{book.pages}", "", message).unwrap();
        assert_eq!(call.path, "/v1/12");
        assert_eq!(call.query, [("book.name".to_string(), "n".to_string())]);
        assert_eq!(call.body, None);
    }

    #[test]
    fn a_rule_without_a_pattern_is_no_binding() {
        let mut out = Vec::new();
        push(&json!({"body": "*"}), &mut out);
        push(&json!({"custom": {"kind": "HEAD"}}), &mut out);
        assert_eq!(out, []);
    }

    #[test]
    fn a_query_cannot_carry_a_structure() {
        let query = |input: &str, message: Value| {
            call_with(input, "/x", "", message).unwrap_err().to_string()
        };
        let well_known = "fixture.legacy.v1.WellKnown";
        // An array for a field that is not repeated, an object that is not
        // the message's own fields, and a list of messages deep inside.
        assert_eq!(
            query(well_known, json!({"listValue": [1]})),
            "the field list_value cannot be sent as a query parameter"
        );
        assert_eq!(
            query(well_known, json!({"structValue": {"a": 1}})),
            "the field struct_value cannot be sent as a query parameter"
        );
        assert_eq!(
            query(
                "fixture.legacy.v1.Tree",
                json!({"parent": {"children": [{"label": "x"}]}})
            ),
            "the field parent.children cannot be sent as a query parameter"
        );
        // A well-known type that is a string in JSON is a value like another.
        let made = call_with(
            well_known,
            "/x",
            "",
            json!({"duration": "1s", "boolWrapper": true}),
        )
        .unwrap();
        assert_eq!(
            made.query,
            [
                ("duration".to_string(), "1s".to_string()),
                ("bool_wrapper".to_string(), "true".to_string())
            ]
        );
        // A request that is itself not an object has no fields to send.
        let schema = Schema::load(IMAGE).unwrap();
        let input = schema.message_index("google.protobuf.Duration").unwrap();
        let binding = Binding {
            verb: "GET".to_string(),
            path: "/x".to_string(),
            body: "seconds".to_string(),
        };
        let made = call(schema.pool(), input, &binding, json!("1s")).unwrap();
        assert_eq!((made.query, made.body.as_deref()), (Vec::new(), Some("{}")));
    }
}
