use serde::Deserialize;

use crate::skill_package_manifest::validate_skill_manifest;

#[derive(Deserialize)]
struct SharedRules {
    package_rules_version: u8,
    cases: Vec<SharedCase>,
}

#[derive(Deserialize)]
struct SharedCase {
    id: String,
    manifest: String,
    accept: bool,
    name: Option<String>,
}

#[test]
fn registry_and_runtime_use_the_same_manifest_acceptance_cases() {
    let rules: SharedRules = serde_json::from_str(include_str!(
        "../../../tests/integration/skill-registry/package-rules-v1.json"
    ))
    .unwrap();
    assert_eq!(rules.package_rules_version, 1);
    for case in rules.cases {
        let result = validate_skill_manifest(case.manifest.as_bytes());
        assert_eq!(result.is_ok(), case.accept, "{}: {result:?}", case.id);
        if let Some(name) = case.name {
            assert_eq!(result.unwrap().name, name, "{}", case.id);
        }
    }
}

#[test]
fn rejects_nested_duplicate_keys_tags_anchors_and_second_documents() {
    for manifest in [
        "---\nname: skill\ndescription: useful\nmeta: {a: 1, a: 2}\n---\n",
        "---\nname: skill\ndescription: useful\nmeta: &saved {a: 1}\n---\n",
        "---\nname: skill\ndescription: useful\nmeta: *saved\n---\n",
        "---\nname: skill\ndescription: useful\nmeta: !!str value\n---\n",
        "---\nname: skill\ndescription: useful\n...\n---\n",
    ] {
        assert!(
            validate_skill_manifest(manifest.as_bytes()).is_err(),
            "{manifest}"
        );
    }
}
