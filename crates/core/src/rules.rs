//! protovalidate: the rules and examples a schema states for its fields.
//!
//! They are read from the `buf.validate` options, shown beside each field,
//! and used to start a body from a plausible value. A part of them is also
//! checked here, to warn before a request is sent: what needs no interpreter.
//! A pattern or a CEL expression is shown and left to the server. The server
//! is the authority in any case; this is a warning, never a refusal.

use std::sync::Arc;

use buffa::editions::FieldPresence;
use buffa_descriptor::{
    DescriptorPool, FieldDescriptor, FieldKind, MessageDescriptor, MessageIndex, SingularKind,
};
use serde::Serialize;
use serde_json::{Value, json};

use crate::schema;

/// What a schema says of one field.
#[derive(Debug, Default)]
pub struct FieldRules {
    pub required: bool,
    /// The rules, each as a few words for a reader.
    pub texts: Vec<String>,
    /// The first example the schema gives, as proto JSON.
    pub example: Option<Value>,
    /// The rules do not apply to a field that is not set.
    ignore_unset: bool,
    /// The rules do not apply at all.
    ignore_always: bool,
    /// The rules of the field's type: `{"uuid": true, "maxLen": "40"}`.
    of_type: Value,
}

impl FieldRules {
    /// The largest number the field takes, when it says.
    pub fn most(&self) -> Option<u32> {
        // A page size is a small whole number.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        number(&self.of_type["lte"])
            .filter(|most| *most >= 1.0)
            .map(|most| most.min(f64::from(u32::MAX)) as u32)
    }
}

/// A rule a body does not meet.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Violation {
    /// Where: `gadget.title`, `bundle[0].slots`, `labels`.
    pub path: String,
    pub message: String,
}

pub fn of_field(pool: &Arc<DescriptorPool>, field: &FieldDescriptor) -> FieldRules {
    let Some(rule) = schema::option(pool, field.options(), "buf.validate.field") else {
        return FieldRules::default();
    };
    let ignore = rule["ignore"].as_str().unwrap_or("");
    // One rule object per type: `string`, `int32`, `repeated`, and so on.
    let (type_name, of_type) = rule
        .as_object()
        .and_then(|rule| rule.iter().find(|(_, value)| value.is_object()))
        .map_or(("", Value::Null), |(name, value)| {
            (name.as_str(), value.clone())
        });
    let unit = if type_name == "bytes" {
        "bytes"
    } else {
        "characters"
    };
    let mut rules = FieldRules {
        required: rule["required"] == true,
        ignore_always: ignore == "IGNORE_ALWAYS",
        ignore_unset: ignore.starts_with("IGNORE_IF_"),
        example: of_type["example"]
            .get(0)
            .map(|example| enum_name(pool, field, example)),
        texts: Vec::new(),
        of_type,
    };
    if rules.required {
        rules.texts.push("required".to_string());
    }
    describe(&rules.of_type, unit, &mut rules.texts);
    rules.texts.extend(cel(&rule));
    rules
}

/// The rules of a message as a whole: the messages of its CEL expressions.
pub fn of_message(pool: &Arc<DescriptorPool>, message: &MessageDescriptor) -> Vec<String> {
    schema::option(pool, message.options(), "buf.validate.message")
        .map_or_else(Vec::new, |rule| cel(&rule))
}

fn cel(rule: &Value) -> Vec<String> {
    let rules = rule["cel"].as_array().into_iter().flatten();
    rules
        .filter_map(|rule| rule["message"].as_str().or(rule["expression"].as_str()))
        .map(str::to_string)
        .collect()
}

/// An example of an enum field is its number; proto JSON wants its name.
fn enum_name(pool: &DescriptorPool, field: &FieldDescriptor, example: &Value) -> Value {
    let (FieldKind::Singular(SingularKind::Enum(index)), Some(number)) =
        (field.kind(), example.as_i64())
    else {
        return example.clone();
    };
    let value = i32::try_from(number)
        .ok()
        .and_then(|number| pool.enumeration(index).value(number));
    value.map_or_else(|| example.clone(), |value| json!(value.name()))
}

/// A number, as proto JSON writes it: 64-bit ones are strings.
fn number(value: &Value) -> Option<f64> {
    value.as_f64().or_else(|| value.as_str()?.parse().ok())
}

/// A value as a reader writes it: a text without its quotes, a whole number
/// without a fraction.
fn show(value: &Value) -> String {
    match (value.as_str(), value.as_f64()) {
        (Some(text), _) => text.to_string(),
        // As an integer: the code that prints a float is large, and the
        // core has no other use for it.
        #[allow(clippy::cast_possible_truncation)]
        (None, Some(number)) if number.fract() == 0.0 && number.abs() < 1e15 => {
            (number as i64).to_string()
        }
        _ => value.to_string(),
    }
}

fn list(value: &Value) -> String {
    let items = value.as_array().into_iter().flatten().map(show);
    items.collect::<Vec<_>>().join(", ")
}

/// A bound: its key in a rule, its sign, and whether a number is within it.
type Bound = (&'static str, &'static str, fn(f64, f64) -> bool);

const BOUNDS: [Bound; 4] = [
    ("gte", "≥", |x, n| x >= n),
    ("gt", ">", |x, n| x > n),
    ("lte", "≤", |x, n| x <= n),
    ("lt", "<", |x, n| x < n),
];

/// The rules on a size, and what is counted. "" stands for the unit of the
/// field: characters of a string, bytes of bytes.
const SIZES: [(&str, &str, &str); 3] = [
    ("minLen", "maxLen", ""),
    ("minItems", "maxItems", "items"),
    ("minPairs", "maxPairs", "entries"),
];

/// The rules of a type, each in a few words.
fn describe(rule: &Value, length_unit: &str, texts: &mut Vec<String>) {
    for (key, sign, _) in BOUNDS {
        if !rule[key].is_null() {
            texts.push(format!("{sign} {}", show(&rule[key])));
        }
    }
    for (min, max, unit) in SIZES {
        let unit = if unit.is_empty() { length_unit } else { unit };
        let (least, most) = (show(&rule[min]), show(&rule[max]));
        match (number(&rule[min]), number(&rule[max])) {
            (Some(_), Some(_)) => texts.push(format!("{least} to {most} {unit}")),
            (Some(min), None) if min > 0.0 => texts.push(format!("at least {least} {unit}")),
            (None, Some(_)) => texts.push(format!("at most {most} {unit}")),
            _ => {}
        }
    }
    if !rule["len"].is_null() {
        texts.push(format!("exactly {} {length_unit}", show(&rule["len"])));
    }
    if let Some(pattern) = rule["pattern"].as_str() {
        texts.push(format!("matches {pattern}"));
    }
    if !rule["const"].is_null() {
        texts.push(format!("always {}", show(&rule["const"])));
    }
    if rule["in"].is_array() {
        texts.push(format!("one of {}", list(&rule["in"])));
    }
    // A rule that is only a name: uuid, email, hostname, unique, definedOnly.
    let named = rule
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(name, value)| **value == true && *name != "const");
    texts.extend(named.map(|(name, _)| match name.as_str() {
        "definedOnly" => "a defined value".to_string(),
        "unique" => "no item twice".to_string(),
        name => name.to_string(),
    }));
}

/// The rules a body does not meet, of those the core can decide.
pub fn check(pool: &Arc<DescriptorPool>, message: MessageIndex, body: &Value) -> Vec<Violation> {
    let mut out = Vec::new();
    walk(pool, message, body, "", &mut out);
    out
}

fn walk(
    pool: &Arc<DescriptorPool>,
    message: MessageIndex,
    body: &Value,
    prefix: &str,
    out: &mut Vec<Violation>,
) {
    let descriptor = pool.message(message);
    // A well-known type is not written with the fields of its message.
    let own_fields = !descriptor.full_name().starts_with("google.protobuf.");
    let Some(object) = body.as_object().filter(|_| own_fields) else {
        return;
    };
    for field in descriptor.fields() {
        let path = format!("{prefix}{}", field.json_name());
        let rules = of_field(pool, field);
        let set = object.get(field.json_name());
        if rules.ignore_always {
            continue;
        }
        if rules.required && set.is_none() {
            out.push(Violation {
                path,
                message: "is required".to_string(),
            });
            continue;
        }
        // A field without presence always has a value: unset, it is zero,
        // and its rules apply to that, unless it says to ignore it.
        let zero = zero(pool, field).filter(|_| !rules.ignore_unset);
        let Some(value) = set.or(zero.as_ref()) else {
            continue;
        };
        let broken = violations(pool, field, &rules.of_type, value);
        out.extend(broken.into_iter().map(|message| Violation {
            path: path.clone(),
            message,
        }));

        let element = match field.kind() {
            FieldKind::Singular(element) | FieldKind::List(element) => element,
            FieldKind::Map { value, .. } => value,
        };
        if let SingularKind::Message(inner) = element {
            match (value, field.kind()) {
                (Value::Array(items), _) => {
                    for (i, item) in items.iter().enumerate() {
                        walk(pool, inner, item, &format!("{path}[{i}]."), out);
                    }
                }
                (Value::Object(entries), FieldKind::Map { .. }) => {
                    for (key, entry) in entries {
                        walk(pool, inner, entry, &format!("{path}[{key:?}]."), out);
                    }
                }
                (single, _) => walk(pool, inner, single, &format!("{path}."), out),
            }
        }
    }
}

/// The value an unset field has, when it has no presence of its own.
fn zero(pool: &DescriptorPool, field: &FieldDescriptor) -> Option<Value> {
    use buffa_descriptor::ScalarType::{Bool, Bytes, String};
    let implicit = field.presence() == FieldPresence::Implicit;
    match field.kind() {
        FieldKind::List(_) => Some(json!([])),
        FieldKind::Map { .. } => Some(json!({})),
        FieldKind::Singular(SingularKind::Scalar(String | Bytes)) if implicit => Some(json!("")),
        FieldKind::Singular(SingularKind::Scalar(Bool)) if implicit => Some(json!(false)),
        FieldKind::Singular(SingularKind::Scalar(_)) if implicit => Some(json!(0)),
        FieldKind::Singular(SingularKind::Enum(index)) if implicit => pool
            .enumeration(index)
            .value(0)
            .map(|value| json!(value.name())),
        // With presence, unset is unset; and so is a message, always.
        FieldKind::Singular(_) => None,
    }
}

fn violations(
    pool: &DescriptorPool,
    field: &FieldDescriptor,
    rule: &Value,
    value: &Value,
) -> Vec<String> {
    let mut out = Vec::new();
    // An enum is a name in JSON and a number in its rules.
    let enumeration = match field.kind() {
        FieldKind::Singular(SingularKind::Enum(index)) => Some(pool.enumeration(index)),
        _ => None,
    };
    let numeric = match (enumeration, value.as_str()) {
        (Some(enumeration), Some(name)) => enumeration.value_by_name(name).map(|value| f64::from(value.number())),
        _ => number(value).filter(|_| !matches!(field.kind(), FieldKind::Singular(SingularKind::Scalar(s)) if !is_number(s))),
    };
    if let Some(x) = numeric {
        for (key, sign, holds) in BOUNDS {
            if number(&rule[key]).is_some_and(|n| !holds(x, n)) {
                out.push(format!("must be {sign} {}", show(&rule[key])));
            }
        }
    }
    if rule["definedOnly"] == true && value.is_number() {
        out.push("must be a defined value".to_string());
    }

    let same = |a: &Value| match numeric {
        Some(x) => number(a) == Some(x),
        None => a == value,
    };
    if !rule["const"].is_null() && !same(&rule["const"]) {
        out.push(format!("must be {}", show(&rule["const"])));
    }
    if let Some(allowed) = rule["in"]
        .as_array()
        .filter(|allowed| !allowed.iter().any(same))
    {
        out.push(format!("must be one of {}", list(&json!(allowed))));
    }

    let sized = ["minLen", "maxLen", "len"]
        .iter()
        .any(|key| !rule[*key].is_null());
    let size = match value {
        Value::Array(items) => Some(items.len()),
        Value::Object(entries) => Some(entries.len()),
        Value::String(text) if sized => Some(length(field, text)),
        _ => None,
    };
    if let Some(size) = size {
        // The page deals in sizes far below where a float loses whole numbers.
        #[allow(clippy::cast_precision_loss)]
        let size = size as f64;
        let length_unit = if is_bytes(field) {
            "bytes"
        } else {
            "characters"
        };
        for (min, max, unit) in SIZES {
            let unit = if unit.is_empty() { length_unit } else { unit };
            if number(&rule[min]).is_some_and(|min| size < min) {
                out.push(format!("needs at least {} {unit}", show(&rule[min])));
            }
            if number(&rule[max]).is_some_and(|max| size > max) {
                out.push(format!("takes at most {} {unit}", show(&rule[max])));
            }
        }
        if number(&rule["len"]).is_some_and(|len| (size - len).abs() > f64::EPSILON) {
            out.push(format!(
                "must be exactly {} {length_unit}",
                show(&rule["len"])
            ));
        }
    }
    if rule["uuid"] == true && value.as_str().is_some_and(|text| !is_uuid(text)) {
        out.push("must be a UUID".to_string());
    }
    let twice = |items: &Vec<Value>| {
        items
            .iter()
            .enumerate()
            .any(|(i, item)| items[..i].contains(item))
    };
    if rule["unique"] == true && value.as_array().is_some_and(twice) {
        out.push("must not have an item twice".to_string());
    }
    out
}

fn is_number(scalar: buffa_descriptor::ScalarType) -> bool {
    use buffa_descriptor::ScalarType::{Bool, Bytes, String};
    !matches!(scalar, String | Bytes | Bool)
}

/// A string is counted in characters, bytes in bytes.
fn length(field: &FieldDescriptor, text: &str) -> usize {
    if is_bytes(field) {
        // The codec has accepted the text as base64: four characters are
        // three bytes, and the padding is none.
        return text.trim_end_matches('=').len() * 3 / 4;
    }
    text.chars().count()
}

fn is_bytes(field: &FieldDescriptor) -> bool {
    use buffa_descriptor::ScalarType::Bytes;
    field.kind() == FieldKind::Singular(SingularKind::Scalar(Bytes))
}

/// Eight, four, four, four and twelve hexadecimal digits.
fn is_uuid(text: &str) -> bool {
    let groups: Vec<&str> = text.split('-').collect();
    let lengths = [8, 4, 4, 4, 12];
    groups.len() == 5
        && groups.iter().zip(lengths).all(|(group, length)| {
            group.len() == length && group.bytes().all(|b| b.is_ascii_hexdigit())
        })
}
