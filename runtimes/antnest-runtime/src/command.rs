use std::ffi::OsString;

use thiserror::Error;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Command {
    Serve,
    McpStdio,
    Tool(ToolCommand),
}

impl Command {
    pub(crate) fn parse<I, S>(arguments: I) -> Result<Self, CommandError>
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        let mut arguments = arguments.into_iter().map(Into::into);
        let argument = arguments.next().ok_or(CommandError::Missing)?;
        if arguments.next().is_some() {
            return Err(CommandError::UnexpectedArguments);
        }
        let argument = argument
            .into_string()
            .map_err(|_| CommandError::InvalidEncoding)?;
        match argument.as_str() {
            "serve" => Ok(Self::Serve),
            "mcp-stdio" => Ok(Self::McpStdio),
            "bash" => Ok(Self::Tool(ToolCommand::Bash)),
            "read" => Ok(Self::Tool(ToolCommand::Read)),
            "write" => Ok(Self::Tool(ToolCommand::Write)),
            "edit" => Ok(Self::Tool(ToolCommand::Edit)),
            "info" => Ok(Self::Tool(ToolCommand::Info)),
            "skill-install" => Ok(Self::Tool(ToolCommand::SkillInstall)),
            "skill-digest" => Ok(Self::Tool(ToolCommand::SkillDigest)),
            "skill-install-clean" => Ok(Self::Tool(ToolCommand::SkillInstallClean)),
            "skill-temporary-install" => Ok(Self::Tool(ToolCommand::SkillTemporaryInstall)),
            "skill-temporary-release" => Ok(Self::Tool(ToolCommand::SkillTemporaryRelease)),
            "skill-temporary-clean" => Ok(Self::Tool(ToolCommand::SkillTemporaryClean)),
            _ => Err(CommandError::Unknown(argument)),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ToolCommand {
    Bash,
    Read,
    Write,
    Edit,
    Info,
    SkillInstall,
    SkillDigest,
    SkillInstallClean,
    SkillTemporaryInstall,
    SkillTemporaryRelease,
    SkillTemporaryClean,
}

impl ToolCommand {
    pub(crate) const fn is_private_maintenance(self) -> bool {
        matches!(
            self,
            Self::SkillInstall
                | Self::SkillDigest
                | Self::SkillInstallClean
                | Self::SkillTemporaryInstall
                | Self::SkillTemporaryRelease
                | Self::SkillTemporaryClean
        )
    }

    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Bash => "bash",
            Self::Read => "read",
            Self::Write => "write",
            Self::Edit => "edit",
            Self::Info => "info",
            Self::SkillInstall => "skill-install",
            Self::SkillDigest => "skill-digest",
            Self::SkillInstallClean => "skill-install-clean",
            Self::SkillTemporaryInstall => "skill-temporary-install",
            Self::SkillTemporaryRelease => "skill-temporary-release",
            Self::SkillTemporaryClean => "skill-temporary-clean",
        }
    }

    pub(crate) const fn may_have_side_effects(self) -> bool {
        !matches!(self, Self::Read | Self::Info | Self::SkillDigest)
    }
}

#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub(crate) enum CommandError {
    #[error("one of serve, bash, read, write, edit, info, or mcp-stdio is required")]
    Missing,
    #[error("runtime command contains invalid UTF-8")]
    InvalidEncoding,
    #[error("runtime command accepts exactly one subcommand")]
    UnexpectedArguments,
    #[error("unknown runtime subcommand {0:?}")]
    Unknown(String),
}

#[cfg(test)]
mod temporary_command_tests {
    use super::Command;

    #[test]
    fn temporary_executors_are_private_parent_only_commands() {
        for name in [
            "skill-temporary-install",
            "skill-temporary-release",
            "skill-temporary-clean",
        ] {
            let command = Command::parse([name]).expect("temporary executor command exists");
            let Command::Tool(tool) = command else {
                panic!("expected executor");
            };
            assert!(tool.is_private_maintenance());
            assert!(tool.may_have_side_effects());
        }
    }

    #[test]
    fn learning_install_executors_are_private_parent_only_commands() {
        for (name, side_effects) in [
            ("skill-install", true),
            ("skill-digest", false),
            ("skill-install-clean", true),
        ] {
            let Command::Tool(tool) = Command::parse([name]).expect("executor command exists")
            else {
                panic!("expected executor");
            };
            assert!(tool.is_private_maintenance(), "{name}");
            assert_eq!(tool.may_have_side_effects(), side_effects, "{name}");
            assert_eq!(tool.as_str(), name);
        }
    }

    #[test]
    fn retired_transaction_executors_are_unknown() {
        for name in [
            "skill-prepare",
            "skill-check",
            "skill-commit",
            "skill-observe",
            "skill-cancel",
            "skill-release",
        ] {
            assert_eq!(
                Command::parse([name]),
                Err(super::CommandError::Unknown(name.into())),
                "{name}"
            );
        }
    }
}
