use crate::lifecycle_error::BootstrapStage;

#[derive(Default)]
pub struct EvidenceBuilder {
    stages: Vec<(BootstrapStage, ProcessSnapshot)>,
}

impl EvidenceBuilder {
    pub fn push(&mut self, name: BootstrapStage, snapshot: ProcessSnapshot) {
        self.stages.push((name, snapshot));
    }

    pub fn finish(self) -> Result<(), String> {
        let expected = [
            BootstrapStage::Entry,
            BootstrapStage::EnvironmentSanitized,
            BootstrapStage::NetworkReady,
            BootstrapStage::RootsReady,
            BootstrapStage::PreTokio,
        ];
        let actual = self
            .stages
            .iter()
            .map(|(name, _)| *name)
            .collect::<Vec<_>>();
        if actual != expected {
            return Err(format!(
                "bootstrap evidence stages are {actual:?}, expected {expected:?}"
            ));
        }
        for (name, snapshot) in &self.stages {
            verify(
                snapshot.uid == 0 && snapshot.gid == 0,
                &format!("{name} identity is not root"),
            )?;
            verify(
                snapshot.thread_count == 1,
                &format!("{name} is not single-threaded"),
            )?;
            verify(!snapshot.dumpable, &format!("{name} remains dumpable"))?;
        }
        Ok(())
    }
}

fn verify(condition: bool, message: &str) -> Result<(), String> {
    condition.then_some(()).ok_or_else(|| message.to_owned())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessSnapshot {
    pub uid: u32,
    pub gid: u32,
    pub supplementary_groups: Vec<u32>,
    pub effective_capabilities: String,
    pub permitted_capabilities: String,
    pub inheritable_capabilities: String,
    pub ambient_capabilities: String,
    pub bounding_capabilities: String,
    pub secure_bits: u64,
    pub dumpable: bool,
    pub no_new_privileges: bool,
    pub thread_count: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_complete_root_supervisor_sequence() {
        let mut evidence = EvidenceBuilder::default();
        evidence.push(BootstrapStage::Entry, root_snapshot());
        evidence.push(BootstrapStage::EnvironmentSanitized, root_snapshot());
        evidence.push(BootstrapStage::NetworkReady, root_snapshot());
        evidence.push(BootstrapStage::RootsReady, root_snapshot());
        evidence.push(BootstrapStage::PreTokio, root_snapshot());

        evidence.finish().expect("valid bootstrap evidence");
    }

    #[test]
    fn rejects_missing_or_non_root_final_state() {
        let mut missing = EvidenceBuilder::default();
        missing.push(BootstrapStage::Entry, root_snapshot());
        assert!(missing.finish().is_err());

        let mut evidence = EvidenceBuilder::default();
        evidence.push(BootstrapStage::Entry, root_snapshot());
        evidence.push(BootstrapStage::EnvironmentSanitized, root_snapshot());
        evidence.push(BootstrapStage::NetworkReady, root_snapshot());
        evidence.push(BootstrapStage::RootsReady, root_snapshot());
        let mut invalid = root_snapshot();
        invalid.uid = 1000;
        invalid.gid = 1000;
        evidence.push(BootstrapStage::PreTokio, invalid);
        assert!(evidence.finish().is_err());
    }

    fn root_snapshot() -> ProcessSnapshot {
        ProcessSnapshot {
            uid: 0,
            gid: 0,
            supplementary_groups: Vec::new(),
            effective_capabilities: "00000000a80425fb".into(),
            permitted_capabilities: "00000000a80425fb".into(),
            inheritable_capabilities: "0000000000000000".into(),
            ambient_capabilities: "0000000000000000".into(),
            bounding_capabilities: "00000000a80425fb".into(),
            secure_bits: 0,
            dumpable: false,
            no_new_privileges: false,
            thread_count: 1,
        }
    }
}
