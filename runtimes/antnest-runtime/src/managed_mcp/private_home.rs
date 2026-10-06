use std::path::PathBuf;

const BASE: &str = "/run/antnest-mcp-home";

pub(crate) fn prepare(uid: u32) -> Result<Vec<(&'static str, PathBuf)>, &'static str> {
    if !(2000..=2007).contains(&uid) {
        return Err("managed MCP private HOME identity invalid");
    }
    let environment = environment(uid);
    prepare_directories(uid, &environment)?;
    Ok(environment)
}

fn environment(uid: u32) -> Vec<(&'static str, PathBuf)> {
    let home = PathBuf::from(BASE).join(uid.to_string());
    vec![
        ("HOME", home.clone()),
        ("TMPDIR", home.join("tmp")),
        ("TMP", home.join("tmp")),
        ("TEMP", home.join("tmp")),
        ("XDG_CACHE_HOME", home.join(".cache")),
        ("XDG_CONFIG_HOME", home.join(".config")),
        ("XDG_DATA_HOME", home.join(".local/share")),
        ("XDG_STATE_HOME", home.join(".local/state")),
        ("XDG_RUNTIME_DIR", home.join("run")),
    ]
}

#[cfg(target_os = "linux")]
fn prepare_directories(uid: u32, environment: &[(&str, PathBuf)]) -> Result<(), &'static str> {
    use nix::unistd::{Gid, Uid, chown};
    use std::fs::{DirBuilder, OpenOptions, Permissions};
    use std::os::fd::AsRawFd as _;
    use std::os::unix::fs::{
        DirBuilderExt as _, MetadataExt as _, OpenOptionsExt as _, PermissionsExt as _,
    };

    let base = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(BASE)
        .map_err(|_| "managed MCP private HOME tmpfs missing")?;
    let metadata = base
        .metadata()
        .map_err(|_| "managed MCP private HOME base invalid")?;
    let mut filesystem = std::mem::MaybeUninit::<libc::statfs>::uninit();
    if unsafe { libc::fstatfs(base.as_raw_fd(), filesystem.as_mut_ptr()) } != 0
        || unsafe { filesystem.assume_init() }.f_type != libc::TMPFS_MAGIC
        || metadata.uid() != 0
        || metadata.gid() != 0
        || metadata.mode() & 0o7777 != 0o711
    {
        return Err("managed MCP private HOME requires root-owned private tmpfs");
    }
    let home = &environment[0].1;
    // No child restart loop exists. Refuse existing entries rather than repair
    // a tree that an earlier server might have replaced with symlinks.
    let create = |path: &std::path::Path| {
        DirBuilder::new()
            .mode(0o700)
            .create(path)
            .and_then(|_| std::fs::set_permissions(path, Permissions::from_mode(0o700)))
            .map_err(|_| "managed MCP private HOME creation failed")
    };
    create(home)?;
    let uid = Uid::from_raw(uid);
    let directories = [
        ".cache",
        ".config",
        ".local",
        ".local/share",
        ".local/state",
        "tmp",
        "run",
    ]
    .map(|name| home.join(name));
    for directory in &directories {
        create(directory)?;
    }
    for directory in &directories {
        chown(directory, Some(uid), Some(Gid::from_raw(1000)))
            .map_err(|_| "managed MCP private HOME ownership failed")?;
    }
    // Keep the parent root-owned 0700 until all children are ready. chmod is
    // applied only while the freshly-created directory still belongs to root.
    chown(home, Some(uid), Some(Gid::from_raw(1000)))
        .map_err(|_| "managed MCP private HOME ownership failed")?;
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn prepare_directories(_: u32, _: &[(&str, PathBuf)]) -> Result<(), &'static str> {
    Err("managed MCP private HOME requires Linux tmpfs")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cache_environment_is_private_and_distinct() {
        let first = environment(2000);
        let other = environment(2001);
        assert_eq!(first[0].1, PathBuf::from(BASE).join("2000"));
        for (_, path) in &first[1..] {
            assert!(path.starts_with(&first[0].1));
        }
        assert!(
            first
                .iter()
                .all(|(_, path)| other.iter().all(|(_, peer)| path != peer))
        );
        assert!(prepare(1000).is_err());
    }
}
