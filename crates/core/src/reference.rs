//! Which fields name a resource, and the list that finds one.
//!
//! An id is data: it differs per environment and cannot be written into a
//! schema. What a schema does say is where ids come from: a field `rack_id`,
//! a message `Rack` with an `id`, a method `ListRacks`. From that the page
//! offers to pick a rack by calling the list, when asked to.
//!
//! The list carries the person's credential, so it is only ever a method the
//! schema declares free of side effects.

use std::collections::BTreeMap;

use buffa_descriptor::generated::descriptor::method_options::IdempotencyLevel;
use buffa_descriptor::{
    FieldDescriptor, FieldKind, MessageIndex, MethodDescriptor, ScalarType, SingularKind,
};
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::error::{Error, Result};
use crate::rules;
use crate::schema::Schema;

/// How to list the resource a field refers to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    /// The message the id belongs to.
    pub resource: String,
    /// `package.Service/Method`: the list that is called.
    pub method: String,
    /// The field of the response that repeats the resource.
    pub items: String,
    /// A field of the resource to show beside its id.
    pub label: Option<String>,
    /// The field of the request that says how many to return, and how many
    /// the page asks for.
    pub page_size: Option<(String, u32)>,
    /// The fields that carry the token of the next page: of the request, and
    /// of the response.
    pub page_token: Option<(String, String)>,
    /// What the list takes besides: a parent's id, a filter.
    pub params: Vec<Param>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Param {
    pub field: String,
    /// The list refuses a request without it.
    pub needed: bool,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Plan {
    pub method: String,
    pub body: String,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Item {
    pub id: String,
    pub label: String,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Page {
    pub items: Vec<Item>,
    /// The token of the next page, or "" when this was the last.
    pub next: String,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Seen {
    pub resource: String,
    pub id: String,
    pub label: String,
}

const LABELS: [&str; 4] = ["name", "title", "display_name", "label"];
const PAGE: u32 = 50;

/// The resources of a schema: every message with an `id` that a declared
/// side-effect-free `List…` method returns.
pub struct Catalog {
    /// By package, then by the resource's full name: its lists.
    lists: BTreeMap<String, BTreeMap<String, Vec<Reference>>>,
}

fn package(full_name: &str, short_levels: usize) -> &str {
    let mut end = full_name.len();
    for _ in 0..short_levels {
        end = full_name[..end].rfind('.').unwrap_or(0);
    }
    &full_name[..end]
}

fn snake(name: &str) -> String {
    let mut out = String::new();
    for (i, c) in name.chars().enumerate() {
        if c.is_ascii_uppercase() && i > 0 {
            out.push('_');
        }
        out.push(c.to_ascii_lowercase());
    }
    out
}

fn short(full_name: &str) -> &str {
    full_name.rsplit('.').next().unwrap_or(full_name)
}

/// What a method lists, when it is one the page may call on its own:
/// unary, and declared to have no side effects.
pub fn of_method(schema: &Schema, service: &str, method: &MethodDescriptor) -> Option<Reference> {
    let pool = schema.pool();
    let safe = method
        .options()
        .and_then(|options| options.idempotency_level)
        == Some(IdempotencyLevel::NO_SIDE_EFFECTS);
    if !safe || method.is_client_streaming() || method.is_server_streaming() {
        return None;
    }
    let output = pool.message(method.output());
    let (items, resource) = output
        .fields()
        .iter()
        .find_map(|field| match field.kind() {
            FieldKind::List(SingularKind::Message(index))
                if pool.message(index).field_by_name("id").is_some() =>
            {
                Some((field, index))
            }
            _ => None,
        })?;
    let resource = pool.message(resource);
    let input = pool.message(method.input());
    let field = |name: &str| {
        input
            .field_by_name(name)
            .map(|field| field.json_name().to_string())
    };

    // What the list refuses to do without: found by asking the rules about
    // an empty request.
    let refused = rules::check(pool, method.input(), &json!({}));
    let params = input
        .fields()
        .iter()
        .filter(|field| !matches!(field.name(), "page_size" | "page_token"));
    let page_size = input.field_by_name("page_size").map(|field| {
        // No more than the list allows.
        let most = rules::of_field(pool, field)
            .most()
            .map_or(PAGE, |most| most.min(PAGE));
        (field.json_name().to_string(), most)
    });
    Some(Reference {
        resource: resource.full_name().to_string(),
        method: format!("{service}/{}", method.name()),
        items: items.json_name().to_string(),
        label: LABELS
            .iter()
            .find_map(|name| Some(resource.field_by_name(name)?.json_name().to_string())),
        page_size,
        page_token: field("page_token").zip(
            output
                .field_by_name("next_page_token")
                .map(|f| f.json_name().to_string()),
        ),
        params: params
            .map(|field| Param {
                field: field.json_name().to_string(),
                needed: refused
                    .iter()
                    .any(|violation| violation.path == field.json_name()),
            })
            .collect(),
    })
}

impl Catalog {
    pub fn new(schema: &Schema) -> Self {
        let mut lists: BTreeMap<String, BTreeMap<String, Vec<Reference>>> = BTreeMap::new();
        for service in schema.pool().services() {
            for method in service
                .methods()
                .iter()
                .filter(|method| method.name().starts_with("List"))
            {
                if let Some(reference) = of_method(schema, service.full_name(), method) {
                    let of_package = lists
                        .entry(package(service.full_name(), 1).to_string())
                        .or_default();
                    of_package
                        .entry(reference.resource.clone())
                        .or_default()
                        .push(reference);
                }
            }
        }
        Self { lists }
    }

    /// Whether a message is something a list returns.
    fn is_resource(&self, full_name: &str) -> bool {
        self.lists
            .values()
            .any(|of_package| of_package.contains_key(full_name))
    }

    /// The list for a field, by convention: `<stem>_id`, one message of the
    /// package named by the stem, and its list. `latest_run_id` finds
    /// `EnvelopeRun`: the stem is tried whole, then without its first words.
    /// More than one message at the first length that finds any: not known,
    /// and no guess is made.
    pub fn for_field(&self, owner: &str, field: &FieldDescriptor) -> Option<Reference> {
        let stem = field
            .name()
            .strip_suffix("_id")
            .filter(|stem| !stem.is_empty())?;
        if field.kind() != FieldKind::Singular(SingularKind::Scalar(ScalarType::String)) {
            return None;
        }
        // The owner may be nested: its package is found among the packages
        // that have lists.
        let of_package = self
            .lists
            .iter()
            .filter(|(name, _)| owner.starts_with(&format!("{name}.")))
            .max_by_key(|(name, _)| name.len())
            .map(|(_, of_package)| of_package)?;
        let words: Vec<&str> = stem.split('_').collect();
        for start in 0..words.len() {
            let stem = words[start..].join("_");
            let named: Vec<&Vec<Reference>> = of_package
                .iter()
                .filter(|(resource, _)| {
                    let name = snake(short(resource));
                    name == stem || name.ends_with(&format!("_{stem}"))
                })
                .map(|(_, lists)| lists)
                .collect();
            match named.as_slice() {
                [] => continue,
                [lists] => return the_list(lists),
                _ => return None,
            }
        }
        None
    }

    /// Ids of resources found in a response, wherever they are in it.
    pub fn seen(&self, schema: &Schema, message: MessageIndex, body: &Value, out: &mut Vec<Seen>) {
        let pool = schema.pool();
        let descriptor = pool.message(message);
        let Some(object) = body.as_object() else {
            return;
        };
        if let (true, Some(id)) = (
            self.is_resource(descriptor.full_name()),
            object.get("id").and_then(scalar),
        ) {
            let label = LABELS
                .iter()
                .find_map(|name| object.get(descriptor.field_by_name(name)?.json_name()));
            out.push(Seen {
                resource: descriptor.full_name().to_string(),
                id,
                label: label.and_then(scalar).unwrap_or_default(),
            });
        }
        for field in descriptor.fields() {
            let element = match field.kind() {
                FieldKind::Singular(element) | FieldKind::List(element) => element,
                FieldKind::Map { value, .. } => value,
            };
            let (SingularKind::Message(inner), Some(value)) =
                (element, object.get(field.json_name()))
            else {
                continue;
            };
            match value {
                Value::Array(items) => items
                    .iter()
                    .for_each(|item| self.seen(schema, inner, item, out)),
                Value::Object(entries) if matches!(field.kind(), FieldKind::Map { .. }) => {
                    entries
                        .values()
                        .for_each(|entry| self.seen(schema, inner, entry, out));
                }
                single => self.seen(schema, inner, single, out),
            }
        }
    }
}

/// Of the lists that return a resource: the only one, or the one named
/// after it (`ListRacks` for `Rack`).
fn the_list(lists: &[Reference]) -> Option<Reference> {
    if let [only] = lists {
        return Some(only.clone());
    }
    let named = lists.iter().find(|list| {
        let name = short(&list.resource);
        let method = list.method.rsplit('/').next().unwrap_or("");
        let plurals = [
            format!("List{name}s"),
            format!("List{name}es"),
            format!("List{}ies", name.trim_end_matches('y')),
        ];
        plurals.iter().any(|plural| plural == method)
    });
    named.cloned()
}

fn scalar(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// The request that lists a resource. `context` holds what is known: the
/// fields of the body being edited, by JSON name.
pub fn request(reference: &Reference, context: &Value, page_token: &str) -> Result<Plan> {
    let mut body = Map::new();
    for param in &reference.params {
        match context
            .get(&param.field)
            .filter(|value| scalar(value).is_some())
        {
            Some(value) => {
                body.insert(param.field.clone(), value.clone());
            }
            None if param.needed => {
                return Err(Error::new(format!(
                    "{} needs {}: set it first",
                    reference
                        .method
                        .rsplit('/')
                        .next()
                        .unwrap_or(&reference.method),
                    param.field
                )));
            }
            None => {}
        }
    }
    if let Some((field, size)) = &reference.page_size {
        body.insert(field.clone(), json!(size));
    }
    if let (Some((field, _)), false) = (&reference.page_token, page_token.is_empty()) {
        body.insert(field.clone(), json!(page_token));
    }
    Ok(Plan {
        method: reference.method.clone(),
        body: Value::Object(body).to_string(),
    })
}

/// The ids and labels in the response of a list.
pub fn read(reference: &Reference, response: &Value) -> Page {
    let items = response[&reference.items]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let label = reference
                .label
                .as_ref()
                .and_then(|label| scalar(&item[label]));
            Some(Item {
                id: scalar(&item["id"])?,
                label: label.unwrap_or_default(),
            })
        });
    let next = reference
        .page_token
        .as_ref()
        .and_then(|(_, field)| response[field].as_str());
    Page {
        items: items.collect(),
        next: next.unwrap_or("").to_string(),
    }
}
