use std::ffi::OsStr;
use std::io;

pub(crate) const TEST_FEATURES: &[&str] = &[
    #[cfg(feature = "skill-maintenance-e2e-gate")]
    "skill-maintenance-e2e-gate",
];

pub(crate) fn validate_test_features(opt_in: Option<&OsStr>) -> io::Result<()> {
    if !TEST_FEATURES.is_empty() && opt_in != Some(OsStr::new("true")) {
        return Err(io::Error::other(format!(
            "Runtime compiled with test features [{}] requires ANTNEST_RUNTIME_ALLOW_TEST_FEATURES=true",
            TEST_FEATURES.join(", ")
        )));
    }
    Ok(())
}
