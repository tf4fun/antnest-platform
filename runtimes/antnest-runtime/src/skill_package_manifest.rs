use std::collections::HashSet;

use yaml_rust2::{
    Yaml,
    parser::{Event, EventReceiver, Parser},
    scanner::TScalarStyle,
};

use crate::information::parse_skill_manifest;

const MAX_SKILL_BYTES: usize = 16 * 1024;
const MAX_YAML_NODES: usize = 512;
const MAX_YAML_DEPTH: usize = 16;

#[derive(Debug, Eq, PartialEq)]
pub(crate) struct SkillManifest {
    pub(crate) name: String,
    pub(crate) description: String,
}

#[derive(Default)]
struct Events(Vec<Event>);

impl EventReceiver for Events {
    fn on_event(&mut self, event: Event) {
        self.0.push(event);
    }
}

enum Node {
    Scalar(String),
    Mapping(Vec<(String, Node)>),
    Sequence,
}

pub(crate) fn validate_skill_manifest(data: &[u8]) -> Result<SkillManifest, &'static str> {
    if data.len() > MAX_SKILL_BYTES || data.starts_with(&[0xef, 0xbb, 0xbf]) {
        return Err("invalid_package");
    }
    let text = std::str::from_utf8(data).map_err(|_| "invalid_package")?;
    let mut lines = text.split('\n');
    if lines.next().map(without_cr) != Some("---") {
        return Err("invalid_package");
    }
    let mut header = Vec::new();
    let mut closed = false;
    for line in lines {
        let line = without_cr(line);
        if line == "---" {
            closed = true;
            break;
        }
        if line == "..." {
            return Err("invalid_package");
        }
        header.push(line);
    }
    if !closed {
        return Err("invalid_package");
    }
    let header = header.join("\n");
    let mut events = Events::default();
    Parser::new_from_str(&header)
        .load(&mut events, true)
        .map_err(|_| "invalid_package")?;
    let mut iter = events.0.iter().peekable();
    if !matches!(iter.next(), Some(Event::StreamStart))
        || !matches!(iter.next(), Some(Event::DocumentStart))
    {
        return Err("invalid_package");
    }
    let mut nodes = 1; // go-yaml counts the document node before its mapping.
    let Node::Mapping(fields) = parse_node(&mut iter, 1, &mut nodes)? else {
        return Err("invalid_package");
    };
    if !matches!(iter.next(), Some(Event::DocumentEnd))
        || !matches!(iter.next(), Some(Event::StreamEnd))
        || iter.next().is_some()
    {
        return Err("invalid_package");
    }
    let mut name = None;
    let mut description = None;
    for (key, value) in fields {
        match (key.as_str(), value) {
            ("name", Node::Scalar(value)) => name = Some(value),
            ("description", Node::Scalar(value)) => description = Some(value),
            ("name" | "description", _) => return Err("invalid_package"),
            _ => {}
        }
    }
    let name = name.ok_or("invalid_package")?;
    let description = description.ok_or("invalid_package")?.trim().to_owned();
    if !valid_name(&name)
        || description.is_empty()
        || description.len() > 512
        || description.contains('\0')
        || parse_skill_manifest(text) != Ok((name.clone(), description.clone()))
    {
        return Err("invalid_package");
    }
    Ok(SkillManifest { name, description })
}

fn without_cr(value: &str) -> &str {
    value.strip_suffix('\r').unwrap_or(value)
}

fn parse_node<'a>(
    iter: &mut std::iter::Peekable<impl Iterator<Item = &'a Event>>,
    depth: usize,
    count: &mut usize,
) -> Result<Node, &'static str> {
    *count += 1;
    if depth > MAX_YAML_DEPTH || *count > MAX_YAML_NODES {
        return Err("invalid_package");
    }
    match iter.next().ok_or("invalid_package")? {
        Event::Scalar(value, style, 0, None) if portable_string(value, *style) => {
            Ok(Node::Scalar(value.clone()))
        }
        Event::MappingStart(0, None) => {
            let mut seen = HashSet::new();
            let mut fields = Vec::new();
            while !matches!(iter.peek(), Some(Event::MappingEnd)) {
                let Node::Scalar(key) = parse_node(iter, depth + 1, count)? else {
                    return Err("invalid_package");
                };
                if key == "<<" || !seen.insert(key.clone()) {
                    return Err("invalid_package");
                }
                let value = parse_node(iter, depth + 1, count)?;
                fields.push((key, value));
            }
            iter.next();
            Ok(Node::Mapping(fields))
        }
        Event::SequenceStart(0, None) => {
            while !matches!(iter.peek(), Some(Event::SequenceEnd)) {
                parse_node(iter, depth + 1, count)?;
            }
            iter.next();
            Ok(Node::Sequence)
        }
        _ => Err("invalid_package"),
    }
}

fn portable_string(value: &str, style: TScalarStyle) -> bool {
    if style != TScalarStyle::Plain {
        return true;
    }
    matches!(Yaml::from_str(value), Yaml::String(_)) && !reject_plain(value)
}

fn reject_plain(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    if value.is_empty()
        || value == "~"
        || matches!(lower.as_str(), "true" | "false" | "null")
        || date_prefix(value)
    {
        return true;
    }
    let signless = if let Some(rest) = value.strip_prefix(['+', '-']) {
        if rest.starts_with(['+', '-']) || rest.as_bytes().first().is_some_and(u8::is_ascii_digit) {
            return true;
        }
        rest
    } else {
        value
    };
    let lower = signless.to_ascii_lowercase();
    if lower.starts_with("0x") || lower.starts_with("0o") || lower.starts_with("0b") {
        return true;
    }
    value.contains('_')
        && value
            .strip_prefix(['+', '-'])
            .unwrap_or(value)
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_digit)
        && value.bytes().all(|byte| {
            byte.is_ascii_digit()
                || byte.is_ascii_hexdigit()
                || matches!(
                    byte,
                    b'_' | b'x'
                        | b'X'
                        | b'o'
                        | b'O'
                        | b'b'
                        | b'B'
                        | b'e'
                        | b'E'
                        | b'.'
                        | b'+'
                        | b'-'
                )
        })
}

fn date_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 8 || !bytes[..4].iter().all(u8::is_ascii_digit) || bytes[4] != b'-' {
        return false;
    }
    let mut index = 5;
    let month_start = index;
    while index < bytes.len() && bytes[index].is_ascii_digit() && index - month_start < 2 {
        index += 1;
    }
    if index == month_start || bytes.get(index) != Some(&b'-') {
        return false;
    }
    index += 1;
    let day_start = index;
    while index < bytes.len() && bytes[index].is_ascii_digit() && index - day_start < 2 {
        index += 1;
    }
    index > day_start && matches!(bytes.get(index), None | Some(b'T' | b't' | b' '))
}

fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && !value.starts_with('-')
        && !value.ends_with('-')
        && !value.contains("--")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}
