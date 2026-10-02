//! What makes a request easy to write: the rules and examples a schema
//! states, the lists that ids are picked from, variables, and the request
//! as code.

mod common;

use common::{named, parse};
use serde_json::{Value, json};
use wirebook_core::Explorer;

const GADGET: &str = "fixture.v1.Gadget";
const UUID: &str = "3f2b6c1e-8a4d-4f0b-9c7e-2d1a5b6c7d8e";

fn field(index: &Value, message: &str, name: &str) -> Value {
    named(&named(&index["messages"], message)["fields"], name).clone()
}

#[test]
fn the_rules_of_a_field_are_told_in_a_few_words() {
    let index = parse(&common::explorer().index());
    let rules = |name: &str| field(&index, GADGET, name)["rules"].clone();
    assert_eq!(rules("id"), json!(["uuid"]));
    assert_eq!(rules("rack_id"), json!(["required", "uuid"]));
    assert_eq!(rules("title"), json!(["1 to 40 characters"]));
    assert_eq!(rules("slots"), json!(["≥ 1", "≤ 3"]));
    assert_eq!(rules("weight_kg"), json!(["> 0"]));
    assert_eq!(rules("rating"), json!(["≥ 0", "< 5"]));
    assert_eq!(rules("kind"), json!(["a defined value"]));
    assert_eq!(rules("tags"), json!(["at most 3 items", "no item twice"]));
    assert_eq!(rules("code"), json!(["matches ^[A-Z]{3}-[0-9]{4}$"]));
    assert_eq!(rules("labels"), json!(["at most 2 entries"]));
    assert_eq!(rules("finish"), json!(["one of matt, gloss"]));
    assert_eq!(rules("serial"), json!(["> 0", "< 9007199254740993"]));
    assert_eq!(rules("boxed"), json!(["always true"]));
    assert_eq!(rules("seal"), json!(["at most 4 bytes"]));
    assert_eq!(rules("revision"), json!(["always r1"]));
    assert_eq!(rules("batch"), json!(["exactly 3 characters"]));
    assert_eq!(rules("second_kind"), json!(["one of 1, 2"]));
    assert_eq!(rules("contact"), json!(["email"]));
    // A CEL rule is told by its message; a rule that asks nothing, not at all.
    assert_eq!(rules("note"), json!(["a note does not start with a space"]));
    // Told by its expression, when it has no message.
    assert_eq!(rules("remark"), json!(["this.size() < 99"]));
    // Switched off, it is still what the schema says.
    assert_eq!(rules("draft"), json!(["at least 5 characters"]));
    assert_eq!(rules("bundle"), json!([]));
    assert_eq!(rules("owner_id"), json!([]));

    assert_eq!(field(&index, GADGET, "rack_id")["required"], true);
    assert_eq!(field(&index, GADGET, "title")["required"], false);
    assert_eq!(field(&index, GADGET, "id")["example"], UUID);
    assert_eq!(field(&index, GADGET, "slots")["example"], 2);
    // An enum's example is a number in the schema, and a name in a body.
    assert_eq!(field(&index, GADGET, "kind")["example"], "GADGET_KIND_TOOL");
    assert_eq!(field(&index, GADGET, "third_kind")["example"], 9);
    assert_eq!(field(&index, GADGET, "finish")["example"], Value::Null);
    assert_eq!(
        named(&index["messages"], GADGET)["rules"],
        json!(["a gadget over 10 kg takes one slot"])
    );
    assert_eq!(
        named(&index["messages"], "fixture.v1.Rack")["rules"],
        json!([])
    );
    assert_eq!(index["problems"], json!([]));
}

#[test]
fn a_body_starts_from_variables_then_examples_then_zero() {
    let explorer = common::explorer();
    let body = parse(
        &explorer
            .template(GADGET, r#"{"rackId": "r", "slots": "9"}"#)
            .unwrap(),
    );
    // A variable named as a text field stands in for it.
    assert_eq!(body["rackId"], "{{rackId}}");
    // The schema's examples.
    assert_eq!(body["id"], UUID);
    assert_eq!(body["title"], "Sprocket");
    // A variable does not stand in for a number: the example does.
    assert_eq!(body["slots"], 2);
    // Neither: the zero value.
    assert_eq!(body["weightKg"], 0);
    assert_eq!(body["ownerId"], "");

    let plain = parse(&explorer.template(GADGET, "{}").unwrap());
    assert_eq!(plain["rackId"], "");
    // With its variables set, the template is a body the codec accepts.
    let text = explorer.template(GADGET, r#"{"rackId": "r"}"#).unwrap();
    assert_eq!(
        parse(
            &explorer
                .validate(GADGET, &text, r#"{"rackId": "r"}"#)
                .unwrap()
        )["ok"],
        true
    );
    assert!(explorer.template(GADGET, "[").is_err());
}

fn check(body: Value) -> Vec<(String, String)> {
    let found = parse(
        &common::explorer()
            .check(GADGET, &body.to_string(), "{}")
            .unwrap(),
    );
    let list = found.as_array().unwrap().iter();
    list.map(|v| {
        (
            v["path"].as_str().unwrap().to_string(),
            v["message"].as_str().unwrap().to_string(),
        )
    })
    .collect()
}

fn good() -> Value {
    json!({
        "id": UUID, "rackId": UUID, "title": "Sprocket", "slots": 2, "weightKg": 1.5,
        "kind": "GADGET_KIND_TOOL", "tags": ["a", "b"], "code": "ABC-1234", "labels": {"a": "1"},
        "finish": "matt", "serial": "5", "boxed": true, "seal": "AAEC", "revision": "r1",
        "batch": "abc", "secondKind": "GADGET_KIND_TOY", "rating": 4.5, "contact": "a@b.c"
    })
}

#[test]
fn a_body_that_meets_its_rules_has_no_warning() {
    assert_eq!(check(good()), []);
}

#[test]
fn each_rule_that_can_be_decided_here_is() {
    let broken = |key: &str, value: Value| {
        let mut body = good();
        body[key] = value;
        check(body)
    };
    let one = |path: &str, message: &str| vec![(path.to_string(), message.to_string())];

    assert_eq!(
        broken("id", json!("not-a-uuid")),
        one("id", "must be a UUID")
    );
    assert_eq!(
        broken("id", json!("3f2b6c1e-8a4d-4f0b-9c7e-2d1a5b6c7dzz")),
        one("id", "must be a UUID")
    );
    assert_eq!(
        broken("id", json!("3f2b6c1e8a4d4f0b9c7e2d1a5b6c7d8e")),
        one("id", "must be a UUID")
    );
    assert_eq!(
        broken("title", json!("")),
        one("title", "needs at least 1 characters")
    );
    assert_eq!(
        broken("title", json!("x".repeat(41))),
        one("title", "takes at most 40 characters")
    );
    // Characters, not bytes.
    assert_eq!(broken("title", json!("é".repeat(40))), []);
    assert_eq!(broken("slots", json!(0)), one("slots", "must be ≥ 1"));
    assert_eq!(broken("slots", json!(4)), one("slots", "must be ≤ 3"));
    assert_eq!(broken("weightKg", json!(0)), one("weightKg", "must be > 0"));
    assert_eq!(broken("rating", json!(5)), one("rating", "must be < 5"));
    // 64-bit numbers are strings in JSON.
    assert_eq!(broken("serial", json!("0")), one("serial", "must be > 0"));
    // An enum is a name in JSON; a number is one it does not define.
    assert_eq!(
        broken("kind", json!(7)),
        one("kind", "must be a defined value")
    );
    assert_eq!(
        broken("secondKind", json!("GADGET_KIND_UNSPECIFIED")),
        one("secondKind", "must be one of 1, 2")
    );
    assert_eq!(
        broken("tags", json!(["a", "b", "c", "d"])),
        one("tags", "takes at most 3 items")
    );
    assert_eq!(
        broken("tags", json!(["a", "a"])),
        one("tags", "must not have an item twice")
    );
    assert_eq!(
        broken("labels", json!({"a": "1", "b": "2", "c": "3"})),
        one("labels", "takes at most 2 entries")
    );
    assert_eq!(
        broken("finish", json!("satin")),
        one("finish", "must be one of matt, gloss")
    );
    assert_eq!(broken("boxed", json!(false)), one("boxed", "must be true"));
    assert_eq!(
        broken("seal", json!("AAECAwQ=")),
        one("seal", "takes at most 4 bytes")
    );
    assert_eq!(
        broken("revision", json!("r2")),
        one("revision", "must be r1")
    );
    assert_eq!(
        broken("batch", json!("ab")),
        one("batch", "must be exactly 3 characters")
    );
    // A pattern, a format and a CEL rule are shown, and left to the server.
    assert_eq!(broken("code", json!("nope")), []);
    assert_eq!(broken("contact", json!("not an address")), []);
    assert_eq!(broken("note", json!(" starts with a space")), []);
}

#[test]
fn a_field_without_presence_is_checked_at_its_zero_value() {
    // proto3: an unset field is its zero value, and its rules apply to that,
    // unless the field says to ignore it (code, finish, contact).
    let paths: Vec<String> = check(json!({})).into_iter().map(|(path, _)| path).collect();
    assert_eq!(
        paths,
        [
            "id",
            "rackId",
            "title",
            "slots",
            "weightKg",
            "serial",
            "boxed",
            "revision",
            "batch",
            "secondKind"
        ]
    );
    assert_eq!(
        check(json!({}))[1],
        ("rackId".to_string(), "is required".to_string())
    );

    // A field with presence is checked only when it is set.
    let explorer = common::explorer();
    let widget = parse(&explorer.check("fixture.v1.Widget", "{}", "{}").unwrap());
    assert_eq!(widget, json!([]));
}

#[test]
fn rules_are_checked_wherever_a_message_is() {
    let mut body = good();
    body["spare"] = json!({"rackId": UUID, "slots": 9});
    body["bundle"] = json!([good(), {"rackId": UUID, "title": "x", "slots": 0}]);
    body["sparesBySlot"] = json!({"left": {"rackId": "nope"}});
    let paths: Vec<String> = check(body)
        .into_iter()
        .map(|(path, message)| format!("{path} {message}"))
        .collect();
    for expected in [
        "spare.slots must be ≤ 3",
        "bundle[1].slots must be ≥ 1",
        "sparesBySlot[\"left\"].rackId must be a UUID",
    ] {
        assert!(
            paths.contains(&expected.to_string()),
            "{expected} not in {paths:?}"
        );
    }
    assert!(
        !paths.iter().any(|path| path.starts_with("bundle[0]")),
        "{paths:?}"
    );

    // Inside a wrapper request, and inside a well-known type, which has no
    // fields of its own to check.
    let explorer = common::explorer();
    let wrapped = parse(
        &explorer
            .check("fixture.v1.CreateGadgetRequest", "{}", "{}")
            .unwrap(),
    );
    assert_eq!(
        wrapped,
        json!([{"path": "gadget", "message": "is required"}])
    );
    let known = explorer.check(
        "fixture.legacy.v1.WellKnown",
        r#"{"timestamp": "2026-01-01T00:00:00Z"}"#,
        "{}",
    );
    assert_eq!(parse(&known.unwrap()), json!([]));
}

#[test]
fn a_body_that_is_not_valid_has_no_rules_to_report() {
    let explorer = common::explorer();
    assert_eq!(explorer.check(GADGET, "{", "{}").unwrap(), "[]");
    assert_eq!(
        explorer.check(GADGET, r#"{"nope": 1}"#, "{}").unwrap(),
        "[]"
    );
    assert_eq!(
        explorer
            .check(GADGET, r#"{"title": "{{unset}}"}"#, "{}")
            .unwrap(),
        "[]"
    );
    assert!(explorer.check("no.Such", "{}", "{}").is_err());
    assert!(explorer.check(GADGET, "{}", "[").is_err());
    // With its variables replaced, a body is checked as it will be sent.
    let found = parse(
        &explorer
            .check(GADGET, r#"{"rackId": "{{rack}}"}"#, r#"{"rack": "nope"}"#)
            .unwrap(),
    );
    assert!(
        found
            .as_array()
            .unwrap()
            .contains(&json!({"path": "rackId", "message": "must be a UUID"}))
    );
}

#[test]
fn a_field_that_names_a_resource_knows_its_list() {
    let index = parse(&common::explorer().index());
    let reference = |message: &str, name: &str| field(&index, message, name)["reference"].clone();

    assert_eq!(
        reference(GADGET, "rack_id"),
        json!({
            "resource": "fixture.v1.Rack",
            "method": "fixture.v1.CatalogService/ListRacks",
            "items": "racks",
            "label": "name",
            "pageSize": null,
            "pageToken": null,
            "params": []
        })
    );
    // A list that pages, and needs its parent.
    assert_eq!(
        reference("fixture.v1.GetGadgetRequest", "gadget_id"),
        json!({
            "resource": "fixture.v1.Gadget",
            "method": "fixture.v1.CatalogService/ListGadgets",
            "items": "gadgets",
            "label": "title",
            // No more than the list allows.
            "pageSize": ["pageSize", 20],
            "pageToken": ["pageToken", "nextPageToken"],
            "params": [{"field": "rackId", "needed": true}, {"field": "kind", "needed": false}]
        })
    );
    // No message of that name; two messages of that name; a list that is
    // not declared free of side effects; a field that is not an id.
    for name in [
        "owner_id",
        "part_id",
        "crate_id",
        "legacy_id",
        "id",
        "title",
    ] {
        assert_eq!(reference(GADGET, name), Value::Null, "{name}");
    }
    // Another package has no such lists.
    assert_eq!(reference("fixture.legacy.v1.Order", "id"), Value::Null);
}

fn with_lookups(lookups: Value) -> Value {
    let options = json!({"lookups": lookups}).to_string();
    parse(&Explorer::new(common::IMAGE, &options).unwrap().index())
}

#[test]
fn the_config_can_name_a_list_or_take_one_away() {
    let index = with_lookups(json!({
        "fixture.v1.Gadget.owner_id": "fixture.v1.CatalogService/ListRacks",
        "fixture.v1.Gadget.rack_id": null,
    }));
    assert_eq!(
        field(&index, GADGET, "owner_id")["reference"]["method"],
        "fixture.v1.CatalogService/ListRacks"
    );
    assert_eq!(field(&index, GADGET, "rack_id")["reference"], Value::Null);
    // The same field of another message keeps its list.
    assert_eq!(
        field(&index, "fixture.v1.ListGadgetsRequest", "rack_id")["reference"]["resource"],
        "fixture.v1.Rack"
    );
    assert_eq!(index["problems"], json!([]));
}

#[test]
fn a_list_the_page_may_not_call_is_refused_and_said() {
    let refused = "is not a unary method, declared with no side effects, that returns a list of messages with an id";
    let index = with_lookups(json!({
        // Not declared free of side effects.
        "fixture.v1.Gadget.crate_id": "fixture.v1.CatalogService/ListCrates",
        // Has effects.
        "fixture.v1.Gadget.owner_id": "fixture.v1.CatalogService/CreateGadget",
        // A stream.
        "fixture.v1.Gadget.part_id": "fixture.v1.WidgetService/WatchWidgets",
        // Free of side effects, and returns no list.
        "fixture.v1.Gadget.title": "fixture.v1.CatalogService/GetGadget",
        "fixture.v1.Gadget.note": "no.Such/Method",
        "fixture.v1.Gadget.nope": "fixture.v1.CatalogService/ListRacks",
    }));
    for name in ["crate_id", "owner_id", "part_id", "title", "note"] {
        assert_eq!(
            field(&index, GADGET, name)["reference"],
            Value::Null,
            "{name}"
        );
    }
    assert_eq!(
        index["problems"],
        json!([
            format!(
                "the lookup for fixture.v1.Gadget.title is not used: fixture.v1.CatalogService/GetGadget {refused}"
            ),
            format!(
                "the lookup for fixture.v1.Gadget.owner_id is not used: fixture.v1.CatalogService/CreateGadget {refused}"
            ),
            format!(
                "the lookup for fixture.v1.Gadget.part_id is not used: fixture.v1.WidgetService/WatchWidgets {refused}"
            ),
            format!(
                "the lookup for fixture.v1.Gadget.crate_id is not used: fixture.v1.CatalogService/ListCrates {refused}"
            ),
            format!("the lookup for fixture.v1.Gadget.note is not used: no.Such/Method {refused}"),
            "the lookup for fixture.v1.Gadget.nope is not used: the schema has no such field",
        ])
    );
    assert!(Explorer::new(common::IMAGE, r#"{"lookup": {}}"#).is_err());
}

#[test]
fn a_list_is_asked_with_what_is_known_and_read_for_ids() {
    let explorer = common::explorer();
    let gadget = "fixture.v1.GetGadgetRequest.gadget_id";
    assert_eq!(
        explorer
            .lookup_request(gadget, "{}", "")
            .unwrap_err()
            .to_string(),
        "ListGadgets needs rackId: set it first"
    );
    assert_eq!(
        explorer
            .lookup_request(gadget, r#"{"rackId": ""}"#, "")
            .unwrap_err()
            .to_string(),
        "ListGadgets needs rackId: set it first"
    );
    let plan = parse(
        &explorer
            .lookup_request(
                gadget,
                r#"{"rackId": "r1", "kind": "GADGET_KIND_TOY", "other": 1}"#,
                "",
            )
            .unwrap(),
    );
    assert_eq!(plan["method"], "fixture.v1.CatalogService/ListGadgets");
    assert_eq!(
        parse(plan["body"].as_str().unwrap()),
        json!({"rackId": "r1", "kind": "GADGET_KIND_TOY", "pageSize": 20})
    );
    // The next page.
    let next = parse(
        &explorer
            .lookup_request(gadget, r#"{"rackId": "r1"}"#, "tok")
            .unwrap(),
    );
    assert_eq!(
        parse(next["body"].as_str().unwrap()),
        json!({"rackId": "r1", "pageSize": 20, "pageToken": "tok"})
    );
    // A list with nothing to say.
    let racks = parse(
        &explorer
            .lookup_request("fixture.v1.Gadget.rack_id", "{}", "ignored")
            .unwrap(),
    );
    assert_eq!(
        racks,
        json!({"method": "fixture.v1.CatalogService/ListRacks", "body": "{}"})
    );

    let page = r#"{"gadgets": [{"id": "g1", "title": "One"}, {"title": "no id"}, {"id": "g2"}, {"id": ""}], "nextPageToken": "n2"}"#;
    assert_eq!(
        parse(&explorer.lookup_read(gadget, page).unwrap()),
        json!({"items": [{"id": "g1", "label": "One"}, {"id": "g2", "label": ""}], "next": "n2"})
    );
    assert_eq!(
        parse(&explorer.lookup_read(gadget, "{}").unwrap()),
        json!({"items": [], "next": ""})
    );
    assert_eq!(
        parse(
            &explorer
                .lookup_read(
                    "fixture.v1.Gadget.rack_id",
                    r#"{"racks": [{"id": "r1", "name": "North"}, {"id": 7}]}"#
                )
                .unwrap()
        ),
        json!({"items": [{"id": "r1", "label": "North"}, {"id": "7", "label": ""}], "next": ""})
    );

    for unknown in [
        "fixture.v1.Gadget.owner_id",
        "fixture.v1.Gadget.nope",
        "no.Such.field",
        "nodots",
    ] {
        assert_eq!(
            explorer
                .lookup_request(unknown, "{}", "")
                .unwrap_err()
                .to_string(),
            format!("the field {unknown} has no list to pick from")
        );
        assert!(explorer.lookup_read(unknown, "{}").is_err());
    }
    assert!(explorer.lookup_request(gadget, "[", "").is_err());
    assert!(explorer.lookup_read(gadget, "[").is_err());
}

#[test]
fn ids_in_a_response_are_noticed_wherever_they_are() {
    let explorer = common::explorer();
    let response = json!({"gadgets": [{
        "id": "g1", "title": "One",
        "spare": {"id": "g2"},
        "bundle": [{"id": "g3", "title": "Three"}, {"title": "no id"}],
        "sparesBySlot": {"a": {"id": "g4"}}
    }]});
    assert_eq!(
        parse(
            &explorer
                .seen("fixture.v1.ListGadgetsResponse", &response.to_string())
                .unwrap()
        ),
        json!([
            {"resource": "fixture.v1.Gadget", "id": "g1", "label": "One"},
            {"resource": "fixture.v1.Gadget", "id": "g2", "label": ""},
            {"resource": "fixture.v1.Gadget", "id": "g3", "label": "Three"},
            {"resource": "fixture.v1.Gadget", "id": "g4", "label": ""}
        ])
    );
    // A message no list returns is not a resource, whatever its id.
    let widget = r#"{"widget": {"id": "w1"}}"#;
    assert_eq!(
        explorer
            .seen("fixture.v1.GetWidgetResponse", widget)
            .unwrap(),
        "[]"
    );
    assert_eq!(
        explorer.seen("google.protobuf.Duration", "\"1s\"").unwrap(),
        "[]"
    );
    assert!(explorer.seen("no.Such", "{}").is_err());
    assert!(
        explorer
            .seen("fixture.v1.ListGadgetsResponse", "[")
            .is_err()
    );
}

fn spec(extra: Value) -> String {
    let mut spec = json!({
        "method": "fixture.v1.WidgetService/GetWidget",
        "body": r#"{"id": "{{widget}}"}"#,
        "transport": "connect-json",
        "baseUrl": "http://localhost:8080",
        "variables": {"widget": "w \"1\"", "trace": "t-9"},
    });
    for (key, value) in extra.as_object().unwrap() {
        spec[key] = value.clone();
    }
    spec.to_string()
}

#[test]
fn variables_are_replaced_in_the_body_and_in_header_values() {
    let explorer = common::explorer();
    let request = explorer
        .request(&spec(
            json!({"headers": [{"name": "X-Trace", "value": "id-{{trace}}"}]}),
        ))
        .unwrap();
    // Escaped: a value cannot end the string it is put in.
    assert_eq!(request.body_text.as_deref(), Some(r#"{"id":"w \"1\""}"#));
    assert_eq!(request.headers[2].value, "id-t-9");

    let unset = explorer
        .request(&spec(json!({"body": r#"{"id": "{{nope}}"}"#})))
        .unwrap_err();
    assert_eq!(
        unset.to_string(),
        "the variable nope is not set in this environment"
    );
    let header = explorer
        .request(&spec(
            json!({"headers": [{"name": "X-A", "value": "{{nope}}"}]}),
        ))
        .unwrap_err();
    assert_eq!(
        header.to_string(),
        "the variable nope is not set in this environment"
    );
    // A variable cannot bring a line break into a header.
    let smuggled = spec(json!({
        "variables": {"widget": "w", "trace": "a\r\nX-Evil: 1"},
        "headers": [{"name": "X-Trace", "value": "{{trace}}"}]
    }));
    assert_eq!(
        explorer.request(&smuggled).unwrap_err().to_string(),
        "the value of the header X-Trace must be plain ASCII text"
    );
    // It is not replaced in the base URL, the header's name or the credential.
    let elsewhere = spec(
        json!({"baseUrl": "http://{{trace}}.example", "auth": {"scheme": "bearer", "token": "{{trace}}"}}),
    );
    let request = explorer.request(&elsewhere).unwrap();
    assert!(request.url.starts_with("http://{{trace}}.example/"));
    assert_eq!(request.headers.last().unwrap().value, "Bearer {{trace}}");

    // Validation and the history see the body as it will be sent.
    let vars = r#"{"widget": "w1"}"#;
    assert_eq!(
        parse(
            &explorer
                .validate(
                    "fixture.v1.GetWidgetRequest",
                    r#"{"id": "{{widget}}"}"#,
                    vars
                )
                .unwrap()
        )["ok"],
        true
    );
    let unset = parse(
        &explorer
            .validate("fixture.v1.GetWidgetRequest", r#"{"id": "{{nope}}"}"#, vars)
            .unwrap(),
    );
    assert_eq!(
        unset,
        json!({"ok": false, "message": "the variable nope is not set in this environment", "line": 1, "column": 1})
    );
    assert!(
        explorer
            .validate("fixture.v1.GetWidgetRequest", "{}", "[")
            .is_err()
    );
    let scrubbed = parse(
        &explorer
            .scrub(
                "fixture.v1.Login",
                r#"{"username": "{{widget}}", "password": "x"}"#,
                vars,
            )
            .unwrap(),
    );
    assert_eq!(
        scrubbed,
        json!({"body": "{\n  \"username\": \"w1\"\n}", "removed": 1})
    );
    assert!(
        explorer
            .scrub("fixture.v1.Login", r#"{"username": "{{nope}}"}"#, vars)
            .is_err()
    );
    assert!(explorer.scrub("fixture.v1.Login", "{}", "[").is_err());
}

#[test]
fn the_request_as_code_in_each_language() {
    let explorer = common::explorer();
    let bearer = json!({
        "method": "fixture.v1.WidgetService/GetWidget", "body": r#"{"id": "w1"}"#, "transport": "connect-json",
        "baseUrl": "http://localhost:8080", "auth": {"scheme": "bearer", "token": "s3cr3t"}
    })
    .to_string();
    let fetch = explorer.snippet(&bearer, "fetch", true).unwrap();
    assert_eq!(
        fetch,
        concat!(
            "const response = await fetch(\"http://localhost:8080/fixture.v1.WidgetService/GetWidget\", {\n",
            "  method: \"POST\",\n",
            "  headers: {\n",
            "    \"Content-Type\": \"application/json\",\n",
            "    \"Connect-Protocol-Version\": \"1\",\n",
            "    \"Authorization\": \"Bearer \" + process.env.TOKEN,\n",
            "  },\n",
            "  body: \"{\\\"id\\\":\\\"w1\\\"}\",\n",
            "});\n",
            "console.log(response.status, await response.text());"
        )
    );
    let python = explorer.snippet(&bearer, "python", true).unwrap();
    assert!(python.starts_with(
        "import os\nimport requests\n\nresponse = requests.request(\n    \"POST\",\n"
    ));
    assert!(python.contains("        \"Authorization\": \"Bearer \" + os.environ[\"TOKEN\"],\n"));
    assert!(python.contains("    data=\"{\\\"id\\\":\\\"w1\\\"}\".encode(),\n)\nprint(response.status_code, response.text)"));
    let go = explorer.snippet(&bearer, "go", true).unwrap();
    assert!(go.starts_with("package main\n\nimport (\n\t\"fmt\"\n\t\"io\"\n\t\"net/http\"\n\t\"os\"\n\t\"strings\"\n)\n\nfunc main() {\n"));
    assert!(go.contains("strings.NewReader(\"{\\\"id\\\":\\\"w1\\\"}\"))"));
    assert!(
        go.contains("\trequest.Header.Set(\"Authorization\", \"Bearer \"+os.Getenv(\"TOKEN\"))\n")
    );
    for code in [&fetch, &python, &go] {
        assert!(!code.contains("s3cr3t"));
    }
    // With the credential, when asked: no environment is read.
    for language in ["fetch", "python", "go"] {
        let code = explorer.snippet(&bearer, language, false).unwrap();
        assert!(code.contains("\"Bearer s3cr3t\""), "{code}");
        assert!(
            !code.contains("environ") && !code.contains("process.env") && !code.contains("\"os\""),
            "{code}"
        );
    }
    assert_eq!(
        explorer.snippet(&bearer, "curl", true).unwrap(),
        explorer.curl(&bearer, true).unwrap()
    );
    let unknown = explorer
        .snippet(&bearer, "cobol", true)
        .unwrap_err()
        .to_string();
    assert!(
        unknown.starts_with("the language is not valid: unknown variant `cobol`"),
        "{unknown}"
    );
}

#[test]
fn code_for_a_key_in_the_url_a_binary_body_and_no_body() {
    let explorer = common::explorer();
    let key = json!({
        "method": "fixture.v1.WidgetService/GetWidget", "body": r#"{"id": "w"}"#, "transport": "connect-proto",
        "baseUrl": "http://localhost:8080", "auth": {"scheme": "api-key", "name": "key", "value": "k3y", "location": "query"}
    })
    .to_string();
    let fetch = explorer.snippet(&key, "fetch", true).unwrap();
    assert!(fetch.contains("GetWidget?key=\" + encodeURIComponent(process.env.API_KEY), {"));
    assert!(fetch.contains("  body: Uint8Array.from(atob(\"CgF3\"), (c) => c.charCodeAt(0)),"));
    let python = explorer.snippet(&key, "python", true).unwrap();
    assert!(python.starts_with("import base64\nimport os\nimport urllib.parse\nimport requests\n"));
    assert!(python.contains("?key=\" + urllib.parse.quote(os.environ[\"API_KEY\"], safe=\"\"),"));
    assert!(python.contains("    data=base64.b64decode(\"CgF3\"),"));
    let go = explorer.snippet(&key, "go", true).unwrap();
    assert!(go.contains("\t\"encoding/base64\"\n\t\"fmt\"\n\t\"io\"\n\t\"net/http\"\n\t\"net/url\"\n\t\"os\"\n\t\"strings\"\n"));
    assert!(go.contains("?key=\"+url.QueryEscape(os.Getenv(\"API_KEY\")), base64.NewDecoder(base64.StdEncoding, strings.NewReader(\"CgF3\")))"));
    // A key in a header is the variable and nothing before it.
    let header = key
        .replace("\"location\":\"query\"", "\"location\":\"header\"")
        .replace("\"name\":\"key\"", "\"name\":\"X-Key\"");
    assert!(
        explorer
            .snippet(&header, "fetch", true)
            .unwrap()
            .contains("    \"X-Key\": process.env.API_KEY,")
    );

    // No body, no headers but one, no credential.
    let get = json!({
        "method": "fixture.v1.WidgetService/GetWidget", "body": r#"{"id": "w"}"#, "transport": "connect-get",
        "baseUrl": "http://localhost:8080"
    })
    .to_string();
    let fetch = explorer.snippet(&get, "fetch", true).unwrap();
    assert!(
        !fetch.contains("headers") && !fetch.contains("body:"),
        "{fetch}"
    );
    let python = explorer.snippet(&get, "python", true).unwrap();
    assert!(
        python.starts_with("import requests\n\n")
            && !python.contains("headers=")
            && !python.contains("data="),
        "{python}"
    );
    let go = explorer.snippet(&get, "go", true).unwrap();
    assert!(
        go.contains("import (\n\t\"fmt\"\n\t\"io\"\n\t\"net/http\"\n)\n"),
        "{go}"
    );
    assert!(go.contains("%7D\", nil)"), "{go}");
}

/// Whatever a name, a URL or a body holds, it stays inside a string of the
/// language: nothing someone else wrote becomes code.
#[test]
fn nothing_in_a_snippet_is_read_as_code() {
    let explorer = common::explorer();
    let hostile = "\"); process.exit(1); //\n' + __import__('os').system('id') + '` ${x} \\";
    let spec = json!({
        "method": "fixture.v1.WidgetService/GetWidget",
        "body": json!({"id": hostile}).to_string(),
        "transport": "connect-json",
        "baseUrl": "http://localhost:8080/a\"b'c`d$e",
        "headers": [{"name": "X-A'`$", "value": "v\"; evil() //"}],
        "auth": {"scheme": "api-key", "name": "k'`", "value": "v\"'`$", "location": "query"},
    })
    .to_string();
    for language in ["fetch", "python", "go"] {
        for redact in [true, false] {
            let code = explorer.snippet(&spec, language, redact).unwrap();
            // Take every double-quoted literal out. What is left is the
            // code, and it is the same code as for a harmless request.
            let mut bare = String::new();
            let (mut quoted, mut escaped) = (false, false);
            for c in code.chars() {
                match (quoted, escaped, c) {
                    (true, true, _) => escaped = false,
                    (true, false, '\\') => escaped = true,
                    (_, false, '"') => quoted = !quoted,
                    (false, _, _) => bare.push(c),
                    _ => {}
                }
            }
            assert!(!quoted, "{language}: a string is left open\n{code}");
            for word in ["evil", "exit", "__import__", "system"] {
                assert!(
                    !bare.contains(word),
                    "{language}: {word} is outside a string\n{code}"
                );
            }
            // No line of the snippet is one of the hostile text's own.
            assert_eq!(code.lines().count(), bare.lines().count(), "{language}");
        }
    }
}
