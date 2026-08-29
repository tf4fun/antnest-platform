use std::ffi::OsString;

use thiserror::Error;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Command {
    Serve,
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
            "bash" => Ok(Self::Tool(ToolCommand::Bash)),
            "read" => Ok(Self::Tool(ToolCommand::Read)),
            "write" => Ok(Self::Tool(ToolCommand::Write)),
            "edit" => Ok(Self::Tool(ToolCommand::Edit)),
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
}

impl ToolCommand {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Bash => "bash",
            Self::Read => "read",
            Self::Write => "write",
            Self::Edit => "edit",
        }
    }

    pub(crate) const fn may_have_side_effects(self) -> bool {
        !matches!(self, Self::Read)
    }
}

#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub(crate) enum CommandError {
    #[error("one of serve, bash, read, write, or edit is required")]
    Missing,
    #[error("runtime command contains invalid UTF-8")]
    InvalidEncoding,
    #[error("runtime command accepts exactly one subcommand")]
    UnexpectedArguments,
    #[error("unknown runtime subcommand {0:?}")]
    Unknown(String),
}
