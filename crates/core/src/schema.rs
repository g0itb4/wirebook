//! The loaded descriptor set: the pool that drives the codec, and the
//! comments of every declaration.

use std::collections::BTreeMap;
use std::sync::Arc;

use buffa_descriptor::generated::descriptor::{EnumDescriptorProto, FileDescriptorProto};
use buffa_descriptor::{
    DescriptorPool, DynamicMessage, FieldDescriptor, MessageIndex, MethodDescriptor,
};
use serde_json::Value;

use crate::error::{Error, Result};
use crate::rules::{self, FieldRules};

/// A descriptor set, linked and ready to answer questions.
pub struct Schema {
    pool: Arc<DescriptorPool>,
    docs: BTreeMap<String, String>,
    rules: rules::Table,
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
        let pool = Arc::new(pool);
        let rules = rules::Table::new(&pool);
        Ok(Self { pool, docs, rules })
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

    /// What the schema asks of a field of `message`.
    pub(crate) fn rules(&self, message: MessageIndex, field: &FieldDescriptor) -> &FieldRules {
        self.rules.of(message, field)
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

/// A custom option, read out of an options message as JSON: the value under
/// `[package.option]`. It can be read only when the descriptor set carries
/// `descriptor.proto` and the file that declares the option, which it does
/// whenever a file imports the latter.
pub(crate) fn option<O>(
    pool: &Arc<DescriptorPool>,
    options: Option<&O>,
    name: &str,
) -> Option<Value>
where
    O: buffa::Message + buffa::MessageName + buffa::ExtensionSet,
{
    // An option of another package is, to descriptor.proto, a field it does
    // not know. Most options have none, and are not decoded a second time.
    let options = options.filter(|options| !options.unknown_fields().is_empty())?;
    let options = DynamicMessage::from_options(Arc::clone(pool), options)?;
    let mut json = serde_json::from_str::<Value>(&options.to_json().ok()?).ok()?;
    json.get_mut(format!("[{name}]")).map(Value::take)
}

pub(crate) fn text(value: &Option<String>) -> &str {
    value.as_deref().unwrap_or("")
}

pub(crate) fn qualify(scope: &str, name: &str) -> String {
    if scope.is_empty() {
        name.to_string()
    } else {
        [scope, ".", name].concat()
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

/// The comments of a file, by the full name of what they are written on.
///
/// protoc records a span for every token of a file, and a comment on few of
/// them: the path of a location is followed only when it carries one.
fn collect_docs(file: &FileDescriptorProto, docs: &mut BTreeMap<String, String>) {
    let Some(info) = file.source_code_info.as_option() else {
        return;
    };
    for location in &info.location {
        let comment = location
            .leading_comments
            .as_deref()
            .or(location.trailing_comments.as_deref());
        if let Some(comment) = comment
            && let Some(name) = declared(file, &location.path)
        {
            docs.insert(name, clean(comment));
        }
    }
}

fn at<T>(list: &[T], index: i32) -> Option<&T> {
    list.get(usize::try_from(index).ok()?)
}

/// The full name of the declaration at a `SourceCodeInfo` path: a message,
/// a field, a oneof, an enum, an enum value, a service or a method. `None`
/// for a path to anything else, such as an option or the name of a field.
fn declared(file: &FileDescriptorProto, path: &[i32]) -> Option<String> {
    let package = text(&file.package);
    match *path {
        [FILE_MESSAGE, index, ref rest @ ..] => {
            let mut message = at(&file.message_type, index)?;
            let mut name = qualify(package, text(&message.name));
            let mut rest = rest;
            // Down through the messages it is nested in.
            while let [MESSAGE_NESTED, index, ref inner @ ..] = *rest {
                message = at(&message.nested_type, index)?;
                name = qualify(&name, text(&message.name));
                rest = inner;
            }
            match *rest {
                [] => Some(name),
                [MESSAGE_FIELD, index] => {
                    Some(qualify(&name, text(&at(&message.field, index)?.name)))
                }
                [MESSAGE_ONEOF, index] => {
                    Some(qualify(&name, text(&at(&message.oneof_decl, index)?.name)))
                }
                [MESSAGE_ENUM, index, ref rest @ ..] => {
                    declared_enum(at(&message.enum_type, index)?, &name, rest)
                }
                _ => None,
            }
        }
        [FILE_ENUM, index, ref rest @ ..] => {
            declared_enum(at(&file.enum_type, index)?, package, rest)
        }
        [FILE_SERVICE, index, ref rest @ ..] => {
            let service = at(&file.service, index)?;
            let name = qualify(package, text(&service.name));
            match *rest {
                [] => Some(name),
                [SERVICE_METHOD, index] => {
                    Some(qualify(&name, text(&at(&service.method, index)?.name)))
                }
                _ => None,
            }
        }
        _ => None,
    }
}

fn declared_enum(enumeration: &EnumDescriptorProto, scope: &str, path: &[i32]) -> Option<String> {
    let name = qualify(scope, text(&enumeration.name));
    match *path {
        [] => Some(name),
        [ENUM_VALUE, index] => Some(qualify(&name, text(&at(&enumeration.value, index)?.name))),
        _ => None,
    }
}

/// A comment as prose. protoc keeps the space after `//` on every line; that
/// goes. A proto comment is wrapped by hand at some column; lines of running
/// text are joined again, so the page wraps them at its own width. A blank
/// line still ends a paragraph, and a line that starts a block (a list item,
/// an indented example) keeps its own line.
fn clean(comment: &str) -> String {
    let mut out = String::with_capacity(comment.len());
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
    // Trimmed where it is: a schema has a comment on most of what it declares.
    out.truncate(out.trim_end().len());
    out.drain(..out.len() - out.trim_start().len());
    out
}

fn starts_block(line: &str) -> bool {
    // A numbered item: digits, then `.` or `)`, then a space.
    let digits = line.bytes().take_while(u8::is_ascii_digit).count();
    let numbered = digits > 0 && matches!(line.as_bytes()[digits..], [b'.' | b')', b' ', ..]);
    numbered || line.starts_with([' ', '\t', '-', '*', '|', '>', '#'])
}
