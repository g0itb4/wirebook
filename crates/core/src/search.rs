//! Search over the names and comments of the documentation model.

use serde::Serialize;

use crate::index::Index;

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Hit {
    /// `service`, `method`, `message`, `field`, `enum` or `value`.
    pub kind: &'static str,
    /// What the hit is called: a full name, or a method's path.
    pub name: String,
    /// The page the hit is on: the service, message or enum.
    pub page: String,
    /// The first line of its comment.
    pub doc: String,
}

/// The best `limit` hits: a name that is the query, then a name that starts
/// with it, then a name that contains it, then a comment that does. Within a
/// rank, the site's own declarations come before the imported ones, and a
/// service, message or enum before a field or a value.
pub fn search(index: &Index, query: &str, limit: usize) -> Vec<Hit> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Vec::new();
    }
    let mut hits = Vec::new();
    let mut offer = |kind, name: &str, page: &str, doc: &str, imported: bool| {
        if let Some(rank) = rank(name, doc, &query) {
            let doc = doc.lines().next().unwrap_or("").to_string();
            // At the same rank, a page before a member of a page.
            let member = name != page && kind != "method";
            let hit = Hit {
                kind,
                name: name.to_string(),
                page: page.to_string(),
                doc,
            };
            hits.push(((rank, imported, member), hit));
        }
    };
    for service in &index.services {
        offer(
            "service",
            &service.name,
            &service.name,
            &service.doc,
            service.imported,
        );
        for method in &service.methods {
            offer(
                "method",
                &method.path,
                &service.name,
                &method.doc,
                service.imported,
            );
        }
    }
    for message in &index.messages {
        offer(
            "message",
            &message.name,
            &message.name,
            &message.doc,
            message.imported,
        );
        for field in &message.fields {
            let name = format!("{}.{}", message.name, field.name);
            offer("field", &name, &message.name, &field.doc, message.imported);
        }
    }
    for enumeration in &index.enums {
        offer(
            "enum",
            &enumeration.name,
            &enumeration.name,
            &enumeration.doc,
            enumeration.imported,
        );
        for value in &enumeration.values {
            let name = format!("{}.{}", enumeration.name, value.name);
            offer(
                "value",
                &name,
                &enumeration.name,
                &value.doc,
                enumeration.imported,
            );
        }
    }
    hits.sort_by(|(a, x), (b, y)| a.cmp(b).then_with(|| x.name.cmp(&y.name)));
    hits.into_iter().take(limit).map(|(_, hit)| hit).collect()
}

fn rank(name: &str, doc: &str, query: &str) -> Option<u8> {
    let name = name.to_lowercase();
    let short = name.rsplit(['.', '/']).next().unwrap_or(&name);
    if short == query {
        Some(0)
    } else if short.starts_with(query) {
        Some(1)
    } else if name.contains(query) {
        Some(2)
    } else if doc.to_lowercase().contains(query) {
        Some(3)
    } else {
        None
    }
}
