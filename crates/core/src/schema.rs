//! The loaded descriptor set: the pool that drives the codec, and the
//! comments of every declaration.

use std::collections::BTreeMap;
use std::sync::Arc;

use buffa_descriptor::generated::descriptor::{
    DescriptorProto, EnumDescriptorProto, FileDescriptorProto,
};
use buffa_descriptor::{DescriptorPool, MessageIndex, MethodDescriptor};

use crate::error::{Error, Result};

/// A descriptor set, linked and ready to answer questions.
pub struct Schema {
    pool: Arc<DescriptorPool>,
    docs: BTreeMap<String, String>,
}

/// A method, with the service it belongs to.
pub struct Method<'a> {
    pub service: &'a str,
    pub descriptor: &'a MethodDescriptor,
}

impl Schema {
    /// Link a serialized `FileDescriptorSet` (a Buf image is one).
    ///
    /// The set comes from the site's own build, so the decoder's bound on
    /// memory, which is sized for input from a stranger, is lifted.
    pub fn load(image: &[u8]) -> Result<Self> {
        let options = buffa::DecodeOptions::new().with_element_memory_limit(usize::MAX);
        let pool = DescriptorPool::decode_with_options(image, &options)
            .map_err(|e| Error::new(format!("the descriptor set is not valid: {e}")))?;
        let mut docs = BTreeMap::new();
        for file in pool.files() {
            collect_docs(file, &mut docs);
        }
        Ok(Self {
            pool: Arc::new(pool),
            docs,
        })
    }

    pub fn pool(&self) -> &Arc<DescriptorPool> {
        &self.pool
    }

    /// The leading comment of a declaration, or "" when it has none.
    ///
    /// A field is `package.Message.field`, an enum value `package.Enum.VALUE`,
    /// a method `package.Service.Method`.
    pub fn doc(&self, full_name: &str) -> &str {
        self.docs.get(full_name).map_or("", String::as_str)
    }

    pub fn message_index(&self, full_name: &str) -> Result<MessageIndex> {
        self.pool
            .message_index(full_name)
            .ok_or_else(|| Error::new(format!("the schema has no message {full_name}")))
    }

    /// Look a method up by its Connect path: `package.Service/Method`.
    pub fn method(&self, path: &str) -> Result<Method<'_>> {
        let missing = || Error::new(format!("the schema has no method {path}"));
        let (service, method) = path
            .trim_start_matches('/')
            .split_once('/')
            .ok_or_else(missing)?;
        let service = self.pool.service_by_name(service).ok_or_else(missing)?;
        let descriptor = service.method(method).ok_or_else(missing)?;
        Ok(Method {
            service: service.full_name(),
            descriptor,
        })
    }
}

pub(crate) fn text(value: &Option<String>) -> &str {
    value.as_deref().unwrap_or("")
}

pub(crate) fn qualify(scope: &str, name: &str) -> String {
    if scope.is_empty() {
        name.to_string()
    } else {
        format!("{scope}.{name}")
    }
}

// descriptor.proto field numbers, as they appear in a SourceCodeInfo path.
const FILE_MESSAGE: i32 = 4;
const FILE_ENUM: i32 = 5;
const FILE_SERVICE: i32 = 6;
const SERVICE_METHOD: i32 = 2;
const MESSAGE_FIELD: i32 = 2;
const MESSAGE_NESTED: i32 = 3;
const MESSAGE_ENUM: i32 = 4;
const MESSAGE_ONEOF: i32 = 8;
const ENUM_VALUE: i32 = 2;

fn child(path: &[i32], field: i32, index: usize) -> Vec<i32> {
    let mut path = path.to_vec();
    path.push(field);
    path.push(i32::try_from(index).unwrap_or(i32::MAX));
    path
}

fn collect_docs(file: &FileDescriptorProto, docs: &mut BTreeMap<String, String>) {
    let Some(info) = file.source_code_info.as_option() else {
        return;
    };
    let package = text(&file.package);
    let mut names = BTreeMap::new();
    for (i, message) in file.message_type.iter().enumerate() {
        name_message(message, package, child(&[], FILE_MESSAGE, i), &mut names);
    }
    for (i, enumeration) in file.enum_type.iter().enumerate() {
        name_enum(enumeration, package, child(&[], FILE_ENUM, i), &mut names);
    }
    for (i, service) in file.service.iter().enumerate() {
        let path = child(&[], FILE_SERVICE, i);
        let name = qualify(package, text(&service.name));
        for (j, method) in service.method.iter().enumerate() {
            names.insert(
                child(&path, SERVICE_METHOD, j),
                qualify(&name, text(&method.name)),
            );
        }
        names.insert(path, name);
    }
    for location in &info.location {
        let comment = location
            .leading_comments
            .as_deref()
            .or(location.trailing_comments.as_deref());
        if let (Some(name), Some(comment)) = (names.get(&location.path), comment) {
            docs.insert(name.clone(), clean(comment));
        }
    }
}

fn name_message(
    message: &DescriptorProto,
    scope: &str,
    path: Vec<i32>,
    names: &mut BTreeMap<Vec<i32>, String>,
) {
    let name = qualify(scope, text(&message.name));
    for (i, field) in message.field.iter().enumerate() {
        names.insert(
            child(&path, MESSAGE_FIELD, i),
            qualify(&name, text(&field.name)),
        );
    }
    for (i, oneof) in message.oneof_decl.iter().enumerate() {
        names.insert(
            child(&path, MESSAGE_ONEOF, i),
            qualify(&name, text(&oneof.name)),
        );
    }
    for (i, nested) in message.nested_type.iter().enumerate() {
        name_message(nested, &name, child(&path, MESSAGE_NESTED, i), names);
    }
    for (i, enumeration) in message.enum_type.iter().enumerate() {
        name_enum(enumeration, &name, child(&path, MESSAGE_ENUM, i), names);
    }
    names.insert(path, name);
}

fn name_enum(
    enumeration: &EnumDescriptorProto,
    scope: &str,
    path: Vec<i32>,
    names: &mut BTreeMap<Vec<i32>, String>,
) {
    let name = qualify(scope, text(&enumeration.name));
    for (i, value) in enumeration.value.iter().enumerate() {
        names.insert(
            child(&path, ENUM_VALUE, i),
            qualify(&name, text(&value.name)),
        );
    }
    names.insert(path, name);
}

/// A comment as prose. protoc keeps the space after `//` on every line; that
/// goes. A proto comment is wrapped by hand at some column; lines of running
/// text are joined again, so the page wraps them at its own width. A blank
/// line still ends a paragraph, and a line that starts a block (a list item,
/// an indented example) keeps its own line.
fn clean(comment: &str) -> String {
    let mut out = String::new();
    let mut running = false;
    for line in comment.lines() {
        let line = line.strip_prefix(' ').unwrap_or(line).trim_end();
        let text = !line.is_empty() && !starts_block(line);
        if text && running {
            out.push(' ');
        } else if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(line);
        running = text;
    }
    out.trim().to_string()
}

fn starts_block(line: &str) -> bool {
    let numbered = line.split_once(['.', ')']).is_some_and(|(number, rest)| {
        !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()) && rest.starts_with(' ')
    });
    numbered || line.starts_with([' ', '\t', '-', '*', '|', '>', '#'])
}
