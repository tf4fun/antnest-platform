use serde::{Deserialize, Serialize};
use yaml_rust2::YamlLoader;

use crate::roots::{FilePreview, NamedRoot, NamedRoots};
use crate::tool_error::{ToolError, ToolErrorCode};

pub(crate) const INFORMATION_URI: &str = "antnest://runtime/info";
pub(crate) const MAX_INSTRUCTION_BYTES: usize = 16 * 1024;
pub(crate) const MAX_MANIFEST_BYTES: usize = 16 * 1024;
pub(crate) const MAX_SCAN_ENTRIES: usize = 128;
pub(crate) const MAX_SKILLS_PER_ROOT: usize = 32;
pub(crate) const MAX_WARNINGS: usize = 67;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RuntimeContext {
    pub(crate) environment: Environment,
    pub(crate) instructions: Option<Instructions>,
    pub(crate) skills: Vec<SkillSummary>,
    pub(crate) warnings: Vec<InformationWarning>,
    pub(crate) truncated: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Environment {
    pub(crate) os: String,
    pub(crate) arch: String,
    pub(crate) home: String,
    pub(crate) workspace: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct InformationPath {
    pub(crate) root: String,
    pub(crate) path: String,
}

impl InformationPath {
    fn new(root: NamedRoot, path: impl Into<String>) -> Self {
        Self {
            root: match root {
                NamedRoot::Workspace => "workspace",
                NamedRoot::SystemSkills => "system_skills",
            }
            .into(),
            path: path.into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Instructions {
    pub(crate) path: InformationPath,
    pub(crate) content: String,
    pub(crate) truncated: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SkillSummary {
    pub(crate) source: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) path: InformationPath,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct InformationWarning {
    pub(crate) path: InformationPath,
    pub(crate) code: String,
}

impl RuntimeContext {
    pub(crate) fn collect(roots: &NamedRoots) -> Result<Self, ToolError> {
        let workspace = roots
            .workspace_root()
            .to_str()
            .filter(|path| path.len() <= 4096)
            .ok_or_else(|| ToolError::new(ToolErrorCode::InvalidPath, "invalid workspace path"))?;
        let mut result = Self {
            environment: Environment {
                os: std::env::consts::OS.into(),
                arch: std::env::consts::ARCH.into(),
                home: workspace.into(),
                workspace: workspace.into(),
            },
            instructions: None,
            skills: Vec::new(),
            warnings: Vec::new(),
            truncated: false,
        };
        result.read_instructions(roots);
        result.read_skills(roots, NamedRoot::SystemSkills, ".", "system");
        result.read_skills(roots, NamedRoot::Workspace, ".antnest/skills", "personal");
        Ok(result)
    }

    fn warn(&mut self, root: NamedRoot, path: &str, code: &str) {
        if self.warnings.len() == MAX_WARNINGS {
            self.truncated = true;
            return;
        }
        self.warnings.push(InformationWarning {
            path: InformationPath::new(root, path),
            code: code.into(),
        });
    }

    fn read_instructions(&mut self, roots: &NamedRoots) {
        let root = NamedRoot::Workspace;
        let preview = match roots.read_preview(root, "AGENTS.md", MAX_INSTRUCTION_BYTES) {
            Ok(preview) => preview,
            Err(error) if error.is_not_found() => return,
            Err(_) => {
                self.warn(root, "AGENTS.md", "unreadable");
                return;
            }
        };
        let truncated = preview.truncated;
        match preview_text(preview) {
            Ok(content) => {
                self.truncated |= truncated;
                self.instructions = Some(Instructions {
                    path: InformationPath::new(root, "AGENTS.md"),
                    content,
                    truncated,
                });
            }
            Err(()) => self.warn(root, "AGENTS.md", "invalid_utf8"),
        }
    }

    fn read_skills(&mut self, roots: &NamedRoots, root: NamedRoot, path: &str, source: &str) {
        let listing = match roots.list_directories(root, path, MAX_SCAN_ENTRIES) {
            Ok(listing) => listing,
            Err(error) if root == NamedRoot::Workspace && error.is_not_found() => return,
            Err(_) => {
                self.warn(root, path, "unreadable");
                return;
            }
        };
        if listing.truncated {
            self.truncated = true;
            self.warn(root, path, "scan_limit");
        }
        let start = self.skills.len();
        for directory in listing.names {
            if self.skills.len() - start == MAX_SKILLS_PER_ROOT {
                self.truncated = true;
                self.warn(root, path, "skill_limit");
                break;
            }
            let manifest = if path == "." {
                format!("{directory}/SKILL.md")
            } else {
                format!("{path}/{directory}/SKILL.md")
            };
            self.read_skill(roots, root, &manifest, source);
        }
    }

    fn read_skill(&mut self, roots: &NamedRoots, root: NamedRoot, path: &str, source: &str) {
        let preview = match roots.read_preview(root, path, MAX_MANIFEST_BYTES) {
            Ok(preview) => preview,
            Err(error) if error.is_not_found() => return,
            Err(_) => {
                self.warn(root, path, "unreadable");
                return;
            }
        };
        let truncated = preview.truncated;
        let Ok(text) = preview_text(preview) else {
            self.warn(root, path, "invalid_utf8");
            return;
        };
        match parse_skill_manifest(&text) {
            Ok((name, description)) => self.skills.push(SkillSummary {
                source: source.into(),
                name,
                description,
                path: InformationPath::new(root, path),
            }),
            Err(()) => self.warn(
                root,
                path,
                if truncated {
                    "too_large"
                } else {
                    "invalid_skill"
                },
            ),
        }
    }
}

fn preview_text(preview: FilePreview) -> Result<String, ()> {
    match std::str::from_utf8(&preview.data) {
        Ok(text) => Ok(text.into()),
        Err(error) if preview.truncated && error.error_len().is_none() => {
            String::from_utf8(preview.data[..error.valid_up_to()].to_vec()).map_err(|_| ())
        }
        Err(_) => Err(()),
    }
}

pub(crate) fn parse_skill_manifest(text: &str) -> Result<(String, String), ()> {
    let mut lines = text.lines();
    if lines.next() != Some("---") {
        return Err(());
    }
    let mut header = Vec::new();
    let mut closed = false;
    for line in lines.by_ref() {
        if line == "---" {
            closed = true;
            break;
        }
        header.push(line);
    }
    if !closed {
        return Err(());
    }
    let documents = YamlLoader::load_from_str(&header.join("\n")).map_err(|_| ())?;
    if documents.len() != 1 {
        return Err(());
    }
    let document = &documents[0];
    let name = bounded_field(document["name"].as_str(), 128)?;
    let description = bounded_field(document["description"].as_str(), 512)?;
    Ok((name, description))
}

fn bounded_field(value: Option<&str>, max_bytes: usize) -> Result<String, ()> {
    let value = value.ok_or(())?.trim();
    if value.is_empty() || value.len() > max_bytes || value.contains('\0') {
        return Err(());
    }
    Ok(value.into())
}
