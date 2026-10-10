//! The documentation model: every file, service, message and enum of the
//! schema, in declaration order, as the browser renders it.

use buffa::editions::{EnumType, FieldPresence};
use buffa_descriptor::generated::descriptor::method_options::IdempotencyLevel;
use buffa_descriptor::generated::descriptor::{
    DescriptorProto, EnumDescriptorProto, FileDescriptorProto, ServiceDescriptorProto,
};
use buffa_descriptor::{
    FieldDescriptor, FieldKind, MessageDescriptor, MessageIndex, MethodDescriptor, ScalarType,
    SingularKind,
};
use std::cell::RefCell;
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::reference::{self, Catalog, Reference};
use crate::rest::{self, Binding};
use crate::rules;
use crate::schema::{Schema, qualify, text};

/// What the site's build tells the index.
#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Options {
    /// The files the site documents; every other file is an import. Empty:
    /// nothing is.
    pub roots: Vec<String>,
    /// The list to pick a field's value from, where the convention finds
    /// none or the wrong one: `package.Message.field` to
    /// `package.Service/Method`, or to `null` for no list.
    pub lookups: BTreeMap<String, Option<String>>,
}

#[derive(Debug, Default, Serialize)]
pub struct Index {
    pub files: Vec<FileDoc>,
    pub services: Vec<ServiceDoc>,
    pub messages: Vec<MessageDoc>,
    pub enums: Vec<EnumDoc>,
    /// What in the site's config could not be used, and why.
    pub problems: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct FileDoc {
    pub name: String,
    pub package: String,
    /// `2024`, `2023`, `proto3` or `proto2`.
    pub edition: String,
    /// The file is a dependency, not one of the files the site documents.
    pub imported: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDoc {
    pub name: String,
    pub file: String,
    pub imported: bool,
    pub doc: String,
    pub deprecated: bool,
    pub methods: Vec<MethodDoc>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MethodDoc {
    pub name: String,
    /// `package.Service/Method`, the key every other call takes.
    pub path: String,
    pub doc: String,
    pub deprecated: bool,
    pub input: String,
    pub output: String,
    pub client_streaming: bool,
    pub server_streaming: bool,
    /// `no_side_effects`, `idempotent` or "".
    pub idempotency: &'static str,
    pub http: Vec<Binding>,
    /// The transports the console can send this method over. Empty for a
    /// method with a client stream: `fetch` cannot send one.
    pub transports: Vec<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDoc {
    pub name: String,
    pub file: String,
    pub imported: bool,
    pub doc: String,
    pub deprecated: bool,
    /// The rules of the message as a whole, each in a few words.
    pub rules: Vec<String>,
    pub fields: Vec<FieldDoc>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldDoc {
    pub name: String,
    pub json_name: String,
    pub number: u32,
    /// `singular`, `repeated` or `map`.
    pub cardinality: &'static str,
    /// `scalar`, `enum` or `message`: what `type` names.
    pub kind: &'static str,
    /// A scalar type, or the full name of an enum or a message. For a map,
    /// the type of its values.
    pub r#type: String,
    /// The scalar type of a map's keys.
    pub map_key: Option<String>,
    /// `explicit`, `implicit` or `required` for a singular field, else "".
    pub presence: &'static str,
    pub oneof: Option<String>,
    pub doc: String,
    pub deprecated: bool,
    /// The schema says a request is refused without it.
    pub required: bool,
    /// What the schema asks of a value, each rule in a few words.
    pub rules: Vec<String>,
    /// A value the schema gives as an example.
    pub example: Option<Value>,
    /// How to list the resource the field refers to.
    pub reference: Option<Reference>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnumDoc {
    pub name: String,
    pub file: String,
    pub imported: bool,
    pub doc: String,
    pub deprecated: bool,
    /// A closed enum rejects a number it does not declare.
    pub closed: bool,
    pub values: Vec<EnumValueDoc>,
}

#[derive(Debug, Serialize)]
pub struct EnumValueDoc {
    pub name: String,
    pub number: i32,
    pub doc: String,
    pub deprecated: bool,
}

/// Build the model.
pub fn index(schema: &Schema, catalog: &Catalog, options: &Options) -> Index {
    let mut out = Index::default();
    let lookups = RefCell::new(options.lookups.clone());
    let problems = RefCell::new(Vec::new());
    for file in schema.pool().files() {
        let name = text(&file.name);
        let package = text(&file.package);
        let roots = &options.roots;
        let scope = Scope {
            schema,
            catalog,
            lookups: &lookups,
            problems: &problems,
            file: name,
            imported: !roots.is_empty() && !roots.iter().any(|root| root == name),
        };
        out.files.push(FileDoc {
            name: name.to_string(),
            package: package.to_string(),
            edition: edition(file),
            imported: scope.imported,
        });
        for message in &file.message_type {
            scope.message(message, package, &mut out);
        }
        for enumeration in &file.enum_type {
            scope.enumeration(enumeration, package, &mut out);
        }
        for service in &file.service {
            scope.service(service, package, &mut out);
        }
    }
    out.problems = problems.into_inner();
    // What is left names no field of the schema.
    for field in lookups.into_inner().into_keys() {
        out.problems.push(format!(
            "the lookup for {field} is not used: the schema has no such field"
        ));
    }
    out
}

fn edition(file: &FileDescriptorProto) -> String {
    match (file.edition, text(&file.syntax)) {
        (Some(edition), _) => format!("{edition:?}")
            .trim_start_matches("EDITION_")
            .to_string(),
        (None, "proto3") => "proto3".to_string(),
        (None, _) => "proto2".to_string(),
    }
}

struct Scope<'a> {
    schema: &'a Schema,
    catalog: &'a Catalog,
    /// The lookups of the config that no field has claimed yet.
    lookups: &'a RefCell<BTreeMap<String, Option<String>>>,
    problems: &'a RefCell<Vec<String>>,
    file: &'a str,
    imported: bool,
}

impl Scope<'_> {
    fn message(&self, message: &DescriptorProto, parent: &str, out: &mut Index) {
        // A map field is declared as a nested entry message; it is the field
        // that is documented, not the entry.
        if message.options.map_entry == Some(true) {
            return;
        }
        let name = qualify(parent, text(&message.name));
        let pool = self.schema.pool();
        let linked = pool
            .message_index(&name)
            .map(|index| (index, pool.message(index)));
        let fields = linked.map_or_else(Vec::new, |(index, descriptor)| {
            let fields = descriptor.fields().iter();
            fields
                .map(|field| self.field(&name, index, descriptor, field))
                .collect()
        });
        out.messages.push(MessageDoc {
            name: name.clone(),
            file: self.file.to_string(),
            imported: self.imported,
            doc: self.schema.doc(&name).to_string(),
            deprecated: message.options.deprecated == Some(true),
            rules: linked.map_or_else(Vec::new, |(_, descriptor)| {
                rules::of_message(pool, descriptor)
            }),
            fields,
        });
        for nested in &message.nested_type {
            self.message(nested, &name, out);
        }
        for enumeration in &message.enum_type {
            self.enumeration(enumeration, &name, out);
        }
    }

    fn field(
        &self,
        message: &str,
        index: MessageIndex,
        descriptor: &MessageDescriptor,
        field: &FieldDescriptor,
    ) -> FieldDoc {
        let pool = self.schema.pool();
        let (cardinality, element, map_key) = match field.kind() {
            FieldKind::Singular(element) => ("singular", element, None),
            FieldKind::List(element) => ("repeated", element, None),
            FieldKind::Map { key, value } => ("map", value, Some(scalar(key))),
        };
        let (kind, r#type) = match element {
            SingularKind::Scalar(scalar_type) => ("scalar", scalar(scalar_type)),
            SingularKind::Enum(index) => ("enum", pool.enumeration(index).full_name().to_string()),
            SingularKind::Message(index) => {
                ("message", pool.message(index).full_name().to_string())
            }
        };
        let presence = match (cardinality, field.presence()) {
            ("singular", FieldPresence::Explicit) => "explicit",
            ("singular", FieldPresence::Implicit) => "implicit",
            ("singular", FieldPresence::LegacyRequired) => "required",
            _ => "",
        };
        // proto3 `optional` is stored as a oneof of one field; it is not one
        // to the reader.
        let oneof = field
            .oneof_index()
            .and_then(|index| descriptor.oneofs().get(usize::from(index)))
            .filter(|oneof| !oneof.is_synthetic())
            .map(|oneof| oneof.name().to_string());
        let rules = self.schema.rules(index, field);
        // What the comments and the config call the field.
        let full_name = qualify(message, field.name());
        FieldDoc {
            required: rules.required,
            rules: rules.texts.clone(),
            example: rules.example.clone(),
            reference: self.reference(message, &full_name, field),
            name: field.name().to_string(),
            json_name: field.json_name().to_string(),
            number: field.number(),
            cardinality,
            kind,
            r#type,
            map_key,
            presence,
            oneof,
            doc: self.schema.doc(&full_name).to_string(),
            deprecated: field.options().and_then(|options| options.deprecated) == Some(true),
        }
    }

    /// The list a field's value is picked from: what the config says, or
    /// else what the names say.
    fn reference(&self, message: &str, key: &str, field: &FieldDescriptor) -> Option<Reference> {
        let Some(configured) = self.lookups.borrow_mut().remove(key) else {
            return self.catalog.for_field(message, field);
        };
        let path = configured?;
        let found = self.schema.method(&path).ok().and_then(|method| {
            reference::of_method(self.schema, method.service, method.descriptor)
        });
        if found.is_none() {
            self.problems.borrow_mut().push(format!(
                "the lookup for {key} is not used: {path} is not a unary method, declared with no side effects, that returns a list of messages with an id"
            ));
        }
        found
    }

    fn enumeration(&self, enumeration: &EnumDescriptorProto, parent: &str, out: &mut Index) {
        let name = qualify(parent, text(&enumeration.name));
        let closed = self
            .schema
            .pool()
            .enum_by_name(&name)
            .is_some_and(|descriptor| descriptor.enum_type() == EnumType::Closed);
        let values = enumeration.value.iter().map(|value| EnumValueDoc {
            name: text(&value.name).to_string(),
            number: value.number.unwrap_or(0),
            doc: self
                .schema
                .doc(&qualify(&name, text(&value.name)))
                .to_string(),
            deprecated: value.options.deprecated == Some(true),
        });
        out.enums.push(EnumDoc {
            file: self.file.to_string(),
            imported: self.imported,
            doc: self.schema.doc(&name).to_string(),
            deprecated: enumeration.options.deprecated == Some(true),
            closed,
            values: values.collect(),
            name,
        });
    }

    fn service(&self, service: &ServiceDescriptorProto, package: &str, out: &mut Index) {
        let name = qualify(package, text(&service.name));
        let methods = self
            .schema
            .pool()
            .service_by_name(&name)
            .map(|descriptor| descriptor.methods());
        out.services.push(ServiceDoc {
            file: self.file.to_string(),
            imported: self.imported,
            doc: self.schema.doc(&name).to_string(),
            deprecated: service.options.deprecated == Some(true),
            methods: methods
                .into_iter()
                .flatten()
                .map(|method| self.method(&name, method))
                .collect(),
            name,
        });
    }

    fn method(&self, service: &str, method: &MethodDescriptor) -> MethodDoc {
        let pool = self.schema.pool();
        let options = method.options();
        let idempotency = match options.and_then(|options| options.idempotency_level) {
            Some(IdempotencyLevel::NO_SIDE_EFFECTS) => "no_side_effects",
            Some(IdempotencyLevel::IDEMPOTENT) => "idempotent",
            _ => "",
        };
        let http = rest::bindings(pool, method);
        MethodDoc {
            name: method.name().to_string(),
            path: format!("{service}/{}", method.name()),
            doc: self
                .schema
                .doc(&qualify(service, method.name()))
                .to_string(),
            deprecated: options.and_then(|options| options.deprecated) == Some(true),
            input: pool.message(method.input()).full_name().to_string(),
            output: pool.message(method.output()).full_name().to_string(),
            client_streaming: method.is_client_streaming(),
            server_streaming: method.is_server_streaming(),
            idempotency,
            transports: transports(method, idempotency, !http.is_empty()),
            http,
        }
    }
}

/// The proto name of a scalar type: `int64`, `string`, and so on.
fn scalar(scalar_type: ScalarType) -> String {
    let mut name = format!("{scalar_type:?}");
    name.make_ascii_lowercase();
    name
}

fn transports(method: &MethodDescriptor, idempotency: &str, has_http: bool) -> Vec<&'static str> {
    if method.is_client_streaming() {
        return Vec::new();
    }
    let mut out = vec!["connect-json", "connect-proto"];
    if !method.is_server_streaming() {
        if idempotency == "no_side_effects" {
            out.push("connect-get");
        }
        if has_http {
            out.push("rest");
        }
    }
    out
}
