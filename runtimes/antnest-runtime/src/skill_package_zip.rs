// L1 package validation is wired before the executor consumes the file inventory.
#![allow(dead_code)]

use std::{
    collections::HashMap,
    io::{Cursor, Read},
};

use sha2::{Digest, Sha256};
use zip::ZipArchive;

use crate::skill_package_manifest::validate_skill_manifest;

const MAX_ARTIFACT_BYTES: usize = 8 * 1024 * 1024;
const MAX_UNPACKED_BYTES: u64 = 32 * 1024 * 1024;
const MAX_SKILL_BYTES: u64 = 16 * 1024;
const MAX_ENTRIES: usize = 256;

#[derive(Debug)]
pub(crate) struct SkillPackage {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) artifact_digest: String,
    pub(crate) content_digest: String,
    pub(crate) unpacked_size: u64,
    pub(crate) files: Vec<SkillPackageFile>,
}

#[derive(Debug)]
pub(crate) struct SkillPackageFile {
    pub(crate) path: String,
    pub(crate) contents: Vec<u8>,
    pub(crate) size: u64,
    pub(crate) digest: String,
    pub(crate) executable: bool,
    raw_digest: [u8; 32],
}

pub(crate) fn validate_skill_zip(artifact: &[u8]) -> Result<SkillPackage, &'static str> {
    if artifact.is_empty() || artifact.len() > MAX_ARTIFACT_BYTES {
        return Err("limit_exceeded");
    }
    let mut archive = ZipArchive::new(Cursor::new(artifact)).map_err(|_| "invalid_package")?;
    if archive.is_empty() || archive.len() > MAX_ENTRIES {
        return Err("limit_exceeded");
    }
    if physical_entry_count(artifact, archive.central_directory_start())? != archive.len() {
        return Err("invalid_package");
    }
    let artifact_digest = digest(artifact);
    let mut seen = HashMap::new();
    let mut files = Vec::new();
    let mut unpacked_size = 0u64;
    let mut manifest = None;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|_| "invalid_package")?;
        let raw_name = std::str::from_utf8(entry.name_raw())
            .map_err(|_| "invalid_package")?
            .to_owned();
        if raw_name != entry.name()
            || entry.encrypted()
            || !safe_extra(entry.extra_data())
            || !portable_encoding(artifact, entry.central_header_start(), entry.name_raw())
        {
            return Err("invalid_package");
        }
        let is_directory = raw_name.ends_with('/');
        let path = raw_name.strip_suffix('/').unwrap_or(&raw_name);
        if !valid_path(path) || seen.insert(path.to_owned(), is_directory).is_some() {
            return Err("invalid_package");
        }
        let mode = entry.unix_mode().unwrap_or(0);
        let file_type = mode & 0o170000;
        if !matches!(file_type, 0 | 0o100000 | 0o040000) || (!is_directory && file_type == 0o040000)
        {
            return Err("invalid_package");
        }
        if is_directory {
            if entry.size() != 0 {
                return Err("invalid_package");
            }
            continue;
        }
        let max_size = if path == "SKILL.md" {
            MAX_SKILL_BYTES
        } else {
            MAX_ARTIFACT_BYTES as u64
        };
        if entry.size() > max_size || unpacked_size + entry.size() > MAX_UNPACKED_BYTES {
            return Err("limit_exceeded");
        }
        let mut contents = Vec::with_capacity(entry.size() as usize);
        let actual = entry
            .by_ref()
            .take(max_size + 1)
            .read_to_end(&mut contents)
            .map_err(|_| "invalid_package")? as u64;
        if actual > max_size
            || actual != entry.size()
            || unpacked_size + actual > MAX_UNPACKED_BYTES
        {
            return Err("limit_exceeded");
        }
        unpacked_size += actual;
        if path == "SKILL.md" {
            manifest = Some(contents.clone());
        }
        let raw_digest: [u8; 32] = Sha256::digest(&contents).into();
        files.push(SkillPackageFile {
            path: path.to_owned(),
            size: actual,
            digest: format!("sha256:{}", hex(&raw_digest)),
            executable: mode & 0o111 != 0,
            raw_digest,
            contents,
        });
    }
    for path in seen.keys() {
        let mut parent = path.as_str();
        while let Some((prefix, _)) = parent.rsplit_once('/') {
            if seen.get(prefix) == Some(&false) {
                return Err("invalid_package");
            }
            parent = prefix;
        }
    }
    let manifest = validate_skill_manifest(&manifest.ok_or("invalid_package")?)?;
    files.sort_by(|left, right| left.path.as_bytes().cmp(right.path.as_bytes()));
    let mut canonical = Sha256::new();
    canonical.update(b"antnest-skill-manifest-v1\0");
    for file in &files {
        canonical.update((file.path.len() as u32).to_be_bytes());
        canonical.update(file.path.as_bytes());
        canonical.update(file.size.to_be_bytes());
        canonical.update(file.raw_digest);
        canonical.update([u8::from(file.executable)]);
    }
    Ok(SkillPackage {
        name: manifest.name,
        description: manifest.description,
        artifact_digest,
        content_digest: format!("sha256:{}", hex(&canonical.finalize())),
        unpacked_size,
        files,
    })
}

fn valid_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && !value.starts_with('/')
        && !value.contains(['\\', '\0'])
        && value.split('/').count() <= 16
        && value
            .split('/')
            .all(|part| !matches!(part, "" | "." | ".."))
}

fn physical_entry_count(artifact: &[u8], start: u64) -> Result<usize, &'static str> {
    let mut offset = usize::try_from(start).map_err(|_| "invalid_package")?;
    let mut count = 0;
    while artifact.get(offset..offset + 4) == Some(b"PK\x01\x02") {
        let header = artifact.get(offset..offset + 46).ok_or("invalid_package")?;
        let name = u16::from_le_bytes([header[28], header[29]]) as usize;
        let extra = u16::from_le_bytes([header[30], header[31]]) as usize;
        let comment = u16::from_le_bytes([header[32], header[33]]) as usize;
        offset = offset
            .checked_add(46 + name + extra + comment)
            .ok_or("invalid_package")?;
        if offset > artifact.len() {
            return Err("invalid_package");
        }
        count += 1;
        if count > MAX_ENTRIES {
            return Err("limit_exceeded");
        }
    }
    if count == 0 {
        return Err("invalid_package");
    }
    Ok(count)
}

fn portable_encoding(artifact: &[u8], start: u64, name: &[u8]) -> bool {
    let Ok(offset) = usize::try_from(start) else {
        return false;
    };
    let Some(header) = artifact.get(offset..offset.saturating_add(46)) else {
        return false;
    };
    if &header[..4] != b"PK\x01\x02" {
        return false;
    }
    let name_len = u16::from_le_bytes([header[28], header[29]]) as usize;
    let extra_len = u16::from_le_bytes([header[30], header[31]]) as usize;
    let comment_len = u16::from_le_bytes([header[32], header[33]]) as usize;
    let end = match offset.checked_add(46 + name_len + extra_len + comment_len) {
        Some(value) => value,
        None => return false,
    };
    let Some(data) = artifact.get(offset + 46..end) else {
        return false;
    };
    let comment = &data[name_len + extra_len..];
    let flags = u16::from_le_bytes([header[8], header[9]]);
    let utf8 = flags & 0x800 != 0;
    name == &data[..name_len]
        && std::str::from_utf8(comment).is_ok()
        && (utf8 || (name.is_ascii() && comment.is_ascii()))
}

fn safe_extra(extra: Option<&[u8]>) -> bool {
    let mut bytes = extra.unwrap_or_default();
    let mut seen = Vec::new();
    while !bytes.is_empty() {
        if bytes.len() < 4 {
            return false;
        }
        let id = u16::from_le_bytes([bytes[0], bytes[1]]);
        let size = u16::from_le_bytes([bytes[2], bytes[3]]) as usize;
        bytes = &bytes[4..];
        if size > bytes.len() || !matches!(id, 0x0001 | 0x5455) || seen.contains(&id) {
            return false;
        }
        seen.push(id);
        bytes = &bytes[size..];
    }
    true
}

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{}", hex(&Sha256::digest(bytes)))
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[(byte >> 4) as usize] as char);
        output.push(DIGITS[(byte & 15) as usize] as char);
    }
    output
}
