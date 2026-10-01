use std::io::{Cursor, Write};

use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

use crate::skill_package_zip::validate_skill_zip;

const MANIFEST: &[u8] =
    b"---\nname: retry-timeouts\ndescription: Handle transient failures\n---\nSteps.\n";

fn archive(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, data) in files {
        writer
            .start_file(
                name,
                SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
            )
            .unwrap();
        writer.write_all(data).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

#[test]
fn validates_inventory_and_canonical_content_identity() {
    let bytes = archive(&[("SKILL.md", MANIFEST), ("references/guide.md", b"Read me")]);
    let package = validate_skill_zip(&bytes).unwrap();
    assert_eq!(package.name, "retry-timeouts");
    assert_eq!(package.description, "Handle transient failures");
    assert_eq!(package.files.len(), 2);
    assert_eq!(package.files[0].path, "SKILL.md");
    assert_eq!(package.files[1].path, "references/guide.md");
    assert_eq!(package.unpacked_size, MANIFEST.len() as u64 + 7);
    assert!(package.content_digest.starts_with("sha256:"));
    assert!(package.artifact_digest.starts_with("sha256:"));
    assert_ne!(package.content_digest, package.artifact_digest);
    let reordered = archive(&[("references/guide.md", b"Read me"), ("SKILL.md", MANIFEST)]);
    assert_eq!(
        validate_skill_zip(&reordered).unwrap().content_digest,
        package.content_digest
    );
}

#[test]
fn accepts_explicit_directory_and_deflated_regular_file() {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .add_directory("references/", SimpleFileOptions::default())
        .unwrap();
    writer
        .start_file(
            "SKILL.md",
            SimpleFileOptions::default().compression_method(CompressionMethod::Deflated),
        )
        .unwrap();
    writer.write_all(MANIFEST).unwrap();
    writer
        .start_file(
            "references/guide.md",
            SimpleFileOptions::default().compression_method(CompressionMethod::Deflated),
        )
        .unwrap();
    writer.write_all(b"Guide").unwrap();
    let package = validate_skill_zip(&writer.finish().unwrap().into_inner()).unwrap();
    assert_eq!(package.files.len(), 2);
}

#[test]
fn rejects_unsafe_paths_duplicate_and_conflicting_entries() {
    for name in ["../escape", "/absolute", "a\\b", "a/./b", "a//b", "a/../b"] {
        let bytes = archive(&[("SKILL.md", MANIFEST), (name, b"x")]);
        assert!(validate_skill_zip(&bytes).is_err(), "{name}");
    }
    let mut duplicate = archive(&[("SKILL.md", MANIFEST), ("SKILL.xx", MANIFEST)]);
    for offset in 0..duplicate.len() - 8 {
        if &duplicate[offset..offset + 8] == b"SKILL.xx" {
            duplicate[offset..offset + 8].copy_from_slice(b"SKILL.md");
        }
    }
    assert!(validate_skill_zip(&duplicate).is_err());
    assert!(
        validate_skill_zip(&archive(&[
            ("SKILL.md", MANIFEST),
            ("a", b"x"),
            ("a/b", b"x")
        ]))
        .is_err()
    );
}

#[test]
fn rejects_corruption_nonregular_files_and_size_limits() {
    let mut corrupt = archive(&[("SKILL.md", MANIFEST)]);
    let offset = corrupt
        .windows(5)
        .position(|part| part == b"Steps")
        .unwrap();
    corrupt[offset] ^= 1;
    assert!(validate_skill_zip(&corrupt).is_err());

    let mut link = archive(&[("SKILL.md", MANIFEST), ("link", b"target")]);
    let central = link
        .windows(4)
        .enumerate()
        .filter_map(|(index, bytes)| (bytes == b"PK\x01\x02").then_some(index))
        .nth(1)
        .unwrap();
    link[central + 5] = 3; // Unix creator
    link[central + 38..central + 42].copy_from_slice(&(0o120777u32 << 16).to_le_bytes());
    assert!(validate_skill_zip(&link).is_err());

    assert!(validate_skill_zip(&vec![0; 8 * 1024 * 1024 + 1]).is_err());
    let large_manifest = vec![b'x'; 16 * 1024 + 1];
    assert!(validate_skill_zip(&archive(&[("SKILL.md", &large_manifest)])).is_err());
    let large_file = vec![b'x'; 8 * 1024 * 1024 + 1];
    assert!(
        validate_skill_zip(&archive(&[("SKILL.md", MANIFEST), ("asset", &large_file)])).is_err()
    );
}

#[test]
fn rejects_non_ascii_name_without_utf8_flag() {
    let mut bytes = archive(&[("SKILL.md", MANIFEST), ("references/指南.md", b"Guide")]);
    assert!(validate_skill_zip(&bytes).is_ok());
    let central = bytes
        .windows(4)
        .enumerate()
        .filter_map(|(index, value)| (value == b"PK\x01\x02").then_some(index))
        .nth(1)
        .unwrap();
    let flags = u16::from_le_bytes([bytes[central + 8], bytes[central + 9]]) & !0x800;
    bytes[central + 8..central + 10].copy_from_slice(&flags.to_le_bytes());
    assert!(validate_skill_zip(&bytes).is_err());
}
