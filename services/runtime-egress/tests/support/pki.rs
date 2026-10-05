use std::{collections::HashMap, fs, path::PathBuf};

use rcgen::{
    BasicConstraints, CertificateParams, CertifiedIssuer, ExtendedKeyUsagePurpose, IsCa, KeyPair,
    KeyUsagePurpose, SanType,
};

pub struct Pki {
    pub root: tempfile::TempDir,
    pub ca: CertifiedIssuer<'static, KeyPair>,
}

impl Pki {
    pub fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let mut params = CertificateParams::default();
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        let ca = CertifiedIssuer::self_signed(params, KeyPair::generate().unwrap()).unwrap();
        fs::write(root.path().join("ca.pem"), ca.pem()).unwrap();
        Self { root, ca }
    }

    pub fn server_params(uris: &[&str]) -> CertificateParams {
        let mut params = CertificateParams::new(vec!["egress.test".to_owned()]).unwrap();
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        params.subject_alt_names.extend(
            uris.iter()
                .map(|uri| SanType::URI((*uri).try_into().unwrap())),
        );
        params
    }

    pub fn write_server(&self, params: CertificateParams) -> (PathBuf, PathBuf) {
        let key = KeyPair::generate().unwrap();
        let cert = params.signed_by(&key, &self.ca).unwrap();
        let cert_path = self.root.path().join("server.pem");
        let key_path = self.root.path().join("server.key");
        fs::write(&cert_path, cert.pem()).unwrap();
        fs::write(&key_path, key.serialize_pem()).unwrap();
        (cert_path, key_path)
    }

    pub fn values(&self, mode: &str, params: CertificateParams) -> HashMap<String, String> {
        let (cert, key) = self.write_server(params);
        HashMap::from([
            ("ANTNEST_SERVICE_AUTH_MODE".to_owned(), mode.to_owned()),
            (
                "ANTNEST_TLS_CA_FILE".to_owned(),
                self.root
                    .path()
                    .join("ca.pem")
                    .to_string_lossy()
                    .into_owned(),
            ),
            (
                "ANTNEST_TLS_CERT_FILE".to_owned(),
                cert.to_string_lossy().into_owned(),
            ),
            (
                "ANTNEST_TLS_KEY_FILE".to_owned(),
                key.to_string_lossy().into_owned(),
            ),
            (
                "ANTNEST_TLS_SERVER_NAME".to_owned(),
                "egress.test".to_owned(),
            ),
        ])
    }
}
