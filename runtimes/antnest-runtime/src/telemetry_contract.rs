use std::collections::BTreeMap;

use opentelemetry::{KeyValue, Value};

use crate::semconv;

const SECRET_KEYS: &[&str] = &[
    "password",
    "passwordhash",
    "authorization",
    "proxyauthorization",
    "cookie",
    "setcookie",
    "token",
    "accesstoken",
    "refreshtoken",
    "idtoken",
    "secret",
    "clientsecret",
    "apikey",
    "privatekey",
    "credential",
    "credentials",
    "workloadcredential",
    "callercontext",
    "cct",
    "connectiondescriptor",
    "generationkey",
    "masterkey",
    "encryptionkey",
];

pub(crate) fn legacy_attributes_enabled(raw: Option<&str>) -> bool {
    match raw {
        Some(value) => !value.trim().eq_ignore_ascii_case("false"),
        None => true,
    }
}

pub(crate) fn alias_attributes_with_legacy(
    attributes: Vec<KeyValue>,
    emit_legacy: bool,
) -> Vec<KeyValue> {
    let aliases: BTreeMap<&str, &str> = semconv::DEPRECATED_ALIASES.iter().copied().collect();
    let mut canonical: BTreeMap<String, Value> = BTreeMap::new();
    for attribute in &attributes {
        if aliases.contains_key(attribute.key.as_str()) {
            continue;
        }
        canonical.insert(attribute.key.as_str().to_owned(), attribute.value.clone());
    }
    for attribute in &attributes {
        let Some(target) = aliases.get(attribute.key.as_str()) else {
            continue;
        };
        canonical
            .entry((*target).to_owned())
            .or_insert_with(|| attribute.value.clone());
    }
    let mut emitted = canonical.clone();
    if emit_legacy {
        for (alias, target) in &aliases {
            if let Some(value) = canonical.get(*target) {
                emitted.insert((*alias).to_owned(), value.clone());
            }
        }
    }
    emitted
        .into_iter()
        .map(|(key, value)| KeyValue::new(key, value))
        .collect()
}

pub(crate) fn alias_attributes(attributes: Vec<KeyValue>) -> Vec<KeyValue> {
    alias_attributes_with_legacy(
        attributes,
        legacy_attributes_enabled(
            std::env::var("ANTNEST_TELEMETRY_LEGACY_ATTRIBUTES")
                .ok()
                .as_deref(),
        ),
    )
}

pub(crate) fn metric_attributes(attributes: Vec<KeyValue>) -> Vec<KeyValue> {
    let aliases: BTreeMap<&str, &str> = semconv::DEPRECATED_ALIASES.iter().copied().collect();
    alias_attributes(attributes)
        .into_iter()
        .filter(|attribute| {
            let key = attribute.key.as_str();
            let target = aliases.get(key).copied().unwrap_or(key);
            !semconv::RESTRICTED_METRIC_ATTRIBUTES.contains(&target)
        })
        .collect()
}

pub(crate) fn capture_rpc_json<T: serde::Serialize>(value: &T) -> serde_json::Result<String> {
    serde_json::to_string(&scrub(serde_json::to_value(value)?))
}

fn scrub(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.into_iter()
                .map(|(key, member)| {
                    let normalized: String = key
                        .chars()
                        .filter(|character| *character != '_' && *character != '-')
                        .flat_map(char::to_lowercase)
                        .collect();
                    if SECRET_KEYS.contains(&normalized.as_str()) {
                        (key, serde_json::Value::String("[REDACTED]".to_owned()))
                    } else {
                        (key, scrub(member))
                    }
                })
                .collect(),
        ),
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.into_iter().map(scrub).collect())
        }
        other => other,
    }
}

#[cfg(test)]
#[path = "telemetry_contract_tests.rs"]
mod tests;
