//! Search over the names and comments of the documentation model.
//!
//! It runs at every keystroke, over every declaration of the schema, so what
//! does not match costs no copy: a name is compared where it is, and a hit
//! is put into words only when it is one of the best.

use std::borrow::Cow;
use std::cmp::Ordering;

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
    let mut search = Search {
        query: &query,
        dotted: query.contains('.'),
        limit,
        best: Vec::new(),
    };
    for service in &index.services {
        let (name, doc, imported) = (&service.name, &service.doc, service.imported);
        search.page("service", name, name, doc, imported);
        for method in &service.methods {
            search.page("method", &method.path, name, &method.doc, imported);
        }
    }
    for message in &index.messages {
        let (name, doc, imported) = (&message.name, &message.doc, message.imported);
        let within = search.page("message", name, name, doc, imported);
        for field in &message.fields {
            search.member("field", name, within, &field.name, &field.doc, imported);
        }
    }
    for enumeration in &index.enums {
        let (name, imported) = (&enumeration.name, enumeration.imported);
        let within = search.page("enum", name, name, &enumeration.doc, imported);
        for value in &enumeration.values {
            search.member("value", name, within, &value.name, &value.doc, imported);
        }
    }
    search.best.iter().map(Found::hit).collect()
}

struct Search<'a> {
    /// In lower case, and not empty.
    query: &'a str,
    /// The query has a dot in it: it can match across a page and its member.
    dotted: bool,
    limit: usize,
    /// The best hits so far, the best first, and no more than `limit`.
    best: Vec<Found<'a>>,
}

/// A hit, before it is known to be one of the best: nothing is copied.
struct Found<'a> {
    /// The rank, then own before imported, then a page before its members.
    order: (u8, bool, bool),
    kind: &'static str,
    /// The name; of a member, the name of its page, with `member` after it.
    name: &'a str,
    member: Option<&'a str>,
    page: &'a str,
    doc: &'a str,
}

impl<'a> Search<'a> {
    /// A declaration with a name of its own: a service, a method, a message,
    /// an enum. Says whether the query is in the name, which is half of the
    /// answer for the members of a page.
    fn page(
        &mut self,
        kind: &'static str,
        name: &'a str,
        page: &'a str,
        doc: &'a str,
        imported: bool,
    ) -> bool {
        let folded = folded(name);
        let within = contains(&folded, self.query);
        let rank = rank(short(&folded), || within, doc, self.query);
        self.keep(rank, imported, false, kind, name, None, page, doc);
        within
    }

    /// A field or an enum value: its name is the page's and its own, with a
    /// dot between. `page_within` is what `page` said of the page.
    fn member(
        &mut self,
        kind: &'static str,
        page: &'a str,
        page_within: bool,
        member: &'a str,
        doc: &'a str,
        imported: bool,
    ) {
        let query = self.query;
        let rank = if page.is_ascii() && member.is_ascii() {
            // The query is in the name when it is in either part; only a
            // query with a dot can lie across the two.
            let within = || {
                page_within
                    || contains(member, query)
                    || (self.dotted && contains(&format!("{page}.{member}"), query))
            };
            rank(short(member), within, doc, query)
        } else {
            // Lower case is not a matter of each letter alone outside ASCII:
            // the name is put together first.
            let name = format!("{page}.{member}").to_lowercase();
            rank(short(&name), || contains(&name, query), doc, query)
        };
        self.keep(rank, imported, true, kind, page, Some(member), page, doc);
    }

    #[allow(clippy::too_many_arguments)]
    fn keep(
        &mut self,
        rank: Option<u8>,
        imported: bool,
        is_member: bool,
        kind: &'static str,
        name: &'a str,
        member: Option<&'a str>,
        page: &'a str,
        doc: &'a str,
    ) {
        let Some(rank) = rank else {
            return;
        };
        let found = Found {
            order: (rank, imported, is_member),
            kind,
            name,
            member,
            page,
            doc,
        };
        // Most of what is found is no better than the worst that is kept.
        let full = self.best.len() >= self.limit;
        if full && self.best.last().is_none_or(|worst| !found.before(worst)) {
            return;
        }
        // After its equals: of two hits alike, the one declared first.
        let at = self.best.partition_point(|kept| !found.before(kept));
        self.best.insert(at, found);
        self.best.truncate(self.limit);
    }
}

impl Found<'_> {
    /// By order, then by name. A member's name is compared as it would be
    /// written, without writing it.
    fn before(&self, other: &Self) -> bool {
        let by_name = || self.spelled().cmp(other.spelled());
        self.order.cmp(&other.order).then_with(by_name) == Ordering::Less
    }

    fn spelled(&self) -> impl Iterator<Item = u8> {
        let member = self.member.into_iter();
        let member = member.flat_map(|member| ".".bytes().chain(member.bytes()));
        self.name.bytes().chain(member)
    }

    fn hit(&self) -> Hit {
        Hit {
            kind: self.kind,
            name: match self.member {
                Some(member) => format!("{}.{member}", self.name),
                None => self.name.to_string(),
            },
            page: self.page.to_string(),
            doc: self.doc.lines().next().unwrap_or("").to_string(),
        }
    }
}

/// A text as the query is compared to it. The comparison disregards the case
/// of ASCII letters, so an ASCII text, which nearly every name is, stays as
/// it is; any other is copied in lower case, as the query is.
fn folded(text: &str) -> Cow<'_, str> {
    if text.is_ascii() {
        Cow::Borrowed(text)
    } else {
        Cow::Owned(text.to_lowercase())
    }
}

/// The last part of a name: `Book` of `fixture.v1.Book`, `GetBook` of
/// `fixture.v1.Library/GetBook`.
fn short(name: &str) -> &str {
    name.rsplit(['.', '/']).next().unwrap_or(name)
}

/// Whether the query is in a folded text.
fn contains(text: &str, query: &str) -> bool {
    let (text, query) = (text.as_bytes(), query.as_bytes());
    let (first, rest) = query.split_first().unwrap_or((&0, &[]));
    text.iter().enumerate().any(|(at, byte)| {
        byte.eq_ignore_ascii_case(first)
            && text[at + 1..]
                .get(..rest.len())
                .is_some_and(|tail| tail.eq_ignore_ascii_case(rest))
    })
}

/// How well a name answers the query: 0 when its last part is the query, 1
/// when that starts with it, 2 when the name has it anywhere, 3 when only
/// the comment has. `short` is folded; `within` says whether the query is in
/// the name.
fn rank(short: &str, within: impl FnOnce() -> bool, doc: &str, query: &str) -> Option<u8> {
    let (short, start) = (short.as_bytes(), query.as_bytes());
    if short.eq_ignore_ascii_case(start) {
        Some(0)
    } else if short
        .get(..start.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(start))
    {
        Some(1)
    } else if within() {
        Some(2)
    } else if contains(&folded(doc), query) {
        Some(3)
    } else {
        None
    }
}
