//! The documentation model: every file, service, message and enum of the
//! schema, in declaration order, as the browser renders it.

use buffa::editions::{EnumType, FieldPresence};
use buffa_descriptor::generated::descriptor::method_options::IdempotencyLevel;
use buffa_descriptor::generated::descriptor::{
    DescriptorProto, EnumDescriptorProto, FileDescriptorProto, ServiceDescriptorProto,
};
use buffa_descriptor::{
    FieldDescriptor, FieldKind, MessageDescriptor, MethodDescriptor, ScalarType, SingularKind,
};
use serde::Serialize;

use crate::rest::{self, Binding};
use crate::schema::{Schema, qualify, text};

#[derive(Debug, Default, Serialize)]
pub struct Index {
    pub files: Vec<FileDoc>,
    pub services: Vec<ServiceDoc>,
    pub messages: Vec<MessageDoc>,
    pub enums: Vec<EnumDoc>,
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

/// Build the model. `roots` names the files the site documents; every other
/// file is marked as imported. With no roots, nothing is.
pub fn index(schema: &Schema, roots: &[String]) -> Index {
    let mut out = Index::default();
    for file in schema.pool().files() {
        let name = text(&file.name);
        let package = text(&file.package);
        let scope = Scope {
            schema,
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
        let descriptor = self.schema.pool().message_by_name(&name);
        let fields = descriptor.into_iter().flat_map(|descriptor| {
            descriptor
                .fields()
                .iter()
                .map(|field| self.field(&name, descriptor, field))
        });
        out.messages.push(MessageDoc {
            name: name.clone(),
            file: self.file.to_string(),
            imported: self.imported,
            doc: self.schema.doc(&name).to_string(),
            deprecated: message.options.deprecated == Some(true),
            fields: fields.collect(),
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
        FieldDoc {
            name: field.name().to_string(),
            json_name: field.json_name().to_string(),
            number: field.number(),
            cardinality,
            kind,
            r#type,
            map_key,
            presence,
            oneof,
            doc: self.schema.doc(&qualify(message, field.name())).to_string(),
            deprecated: field.options().and_then(|options| options.deprecated) == Some(true),
        }
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
    format!("{scalar_type:?}").to_lowercase()
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
