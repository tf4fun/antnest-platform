use std::collections::HashMap;

use antnest_runtime_egress::config::{Config, ConfigError, DatabaseTlsMode};

#[test]
fn rejects_published_development_database_passwords() {
    for dsn in [
        "postgres://egress:antnest-egress-dev@postgres/egress",
        "postgres://egress:%61ntnest-egress-dev@postgres/egress",
        "postgres://egress@postgres/egress?password=antnest-egress-dev",
        "host=postgres user=egress password='antnest-egress-dev' dbname=egress",
    ] {
        let values = HashMap::from([
            ("ANTNEST_EGRESS_DATABASE_URL".to_owned(), dsn.to_owned()),
            (
                "ANTNEST_EGRESS_UDP_ADVERTISE".to_owned(),
                "10.20.0.8:8092".to_owned(),
            ),
            (
                "ANTNEST_EGRESS_DNS_UPSTREAM".to_owned(),
                "10.20.0.53:53".to_owned(),
            ),
        ]);
        assert!(
            Config::from_values(values).is_err(),
            "published password was accepted"
        );
    }
}

#[test]
fn public_development_opt_in_uses_shared_vectors_and_names_warnings() {
    let contract: serde_json::Value = serde_json::from_str(include_str!(
        "../../../contracts/platform/development-secrets.json"
    ))
    .unwrap();
    let mut values = HashMap::from([
        (
            "ANTNEST_EGRESS_DATABASE_URL".to_owned(),
            "postgres://egress:private@postgres/egress".to_owned(),
        ),
        (
            "ANTNEST_EGRESS_UDP_ADVERTISE".to_owned(),
            "10.20.0.8:8092".to_owned(),
        ),
        (
            "ANTNEST_EGRESS_DNS_UPSTREAM".to_owned(),
            "10.20.0.53:53".to_owned(),
        ),
    ]);
    assert!(
        Config::from_values(values.clone())
            .unwrap()
            .development_secret_warnings
            .is_empty()
    );
    for value in contract["published_values"].as_array().unwrap() {
        values.insert(
            "ANTNEST_EGRESS_DATABASE_URL".to_owned(),
            format!(
                "postgres://egress:{}@postgres/egress",
                value.as_str().unwrap()
            ),
        );
        values.remove("ANTNEST_ALLOW_PUBLIC_DEV_SECRETS");
        assert_eq!(
            Config::from_values(values.clone()).unwrap_err(),
            ConfigError::PublishedDevelopmentValue("ANTNEST_EGRESS_DATABASE_URL")
        );
        values.insert(
            "ANTNEST_ALLOW_PUBLIC_DEV_SECRETS".to_owned(),
            "true".to_owned(),
        );
        assert_eq!(
            Config::from_values(values.clone())
                .unwrap()
                .development_secret_warnings,
            vec!["ANTNEST_EGRESS_DATABASE_URL"]
        );
    }
    for value in contract["invalid_values"].as_array().unwrap() {
        values.insert(
            "ANTNEST_ALLOW_PUBLIC_DEV_SECRETS".to_owned(),
            value.as_str().unwrap().to_owned(),
        );
        assert_eq!(
            Config::from_values(values.clone()).unwrap_err(),
            ConfigError::Invalid("ANTNEST_ALLOW_PUBLIC_DEV_SECRETS")
        );
    }
}

#[test]
fn config_has_bounded_operational_defaults() {
    let config = Config::from_values(HashMap::from([
        (
            "ANTNEST_EGRESS_DATABASE_URL".to_owned(),
            "postgres://egress:secret@postgres/egress".to_owned(),
        ),
        (
            "ANTNEST_EGRESS_UDP_ADVERTISE".to_owned(),
            "10.20.0.8:8092".to_owned(),
        ),
        (
            "ANTNEST_EGRESS_DNS_UPSTREAM".to_owned(),
            "10.20.0.53:53".to_owned(),
        ),
    ]))
    .unwrap();

    assert_eq!(config.control_listen.to_string(), "127.0.0.1:8081");
    assert_eq!(config.udp_advertise.to_string(), "10.20.0.8:8092");
    assert_eq!(config.max_flows, 65_536);
    assert_eq!(config.max_agent_flows, 1_024);
    assert_eq!(config.tun_name, "antnest-egress0");
    assert_eq!(config.database_startup_timeout.as_secs(), 30);
    assert_eq!(config.database_retry_delay.as_millis(), 250);
    assert_eq!(config.database_tls_mode, DatabaseTlsMode::Require);
    assert_eq!(config.dns_upstream.to_string(), "10.20.0.53:53");
}

#[test]
fn control_listener_accepts_only_an_explicit_ipv4_address() {
    for endpoint in [
        "0.0.0.0:8081",
        "[::]:8081",
        "[::ffff:0.0.0.0]:8081",
        "[2001:db8::1]:8081",
    ] {
        let values = HashMap::from([
            (
                "ANTNEST_EGRESS_DATABASE_URL".to_owned(),
                "postgres://localhost/egress".to_owned(),
            ),
            (
                "ANTNEST_EGRESS_CONTROL_LISTEN".to_owned(),
                endpoint.to_owned(),
            ),
            (
                "ANTNEST_EGRESS_UDP_ADVERTISE".to_owned(),
                "10.20.0.8:8092".to_owned(),
            ),
            (
                "ANTNEST_EGRESS_DNS_UPSTREAM".to_owned(),
                "10.20.0.53:53".to_owned(),
            ),
        ]);

        assert_eq!(
            Config::from_values(values),
            Err(ConfigError::Invalid("ANTNEST_EGRESS_CONTROL_LISTEN")),
            "{endpoint}"
        );
    }
}

#[test]
fn database_tls_must_be_explicitly_disabled_for_local_development() {
    let base = [
        (
            "ANTNEST_EGRESS_DATABASE_URL".to_owned(),
            "postgres://localhost/egress".to_owned(),
        ),
        (
            "ANTNEST_EGRESS_UDP_ADVERTISE".to_owned(),
            "10.20.0.8:8092".to_owned(),
        ),
        (
            "ANTNEST_EGRESS_DNS_UPSTREAM".to_owned(),
            "10.20.0.53:53".to_owned(),
        ),
    ];
    let mut disabled = HashMap::from(base.clone());
    disabled.insert(
        "ANTNEST_EGRESS_DATABASE_TLS_MODE".to_owned(),
        "disable".to_owned(),
    );
    assert_eq!(
        Config::from_values(disabled).unwrap().database_tls_mode,
        DatabaseTlsMode::Disable
    );

    let mut invalid = HashMap::from(base);
    invalid.insert(
        "ANTNEST_EGRESS_DATABASE_TLS_MODE".to_owned(),
        "prefer".to_owned(),
    );
    assert_eq!(
        Config::from_values(invalid),
        Err(ConfigError::Invalid("ANTNEST_EGRESS_DATABASE_TLS_MODE"))
    );
}

#[test]
fn advertised_endpoint_is_literal_ipv4() {
    let values = HashMap::from([
        (
            "ANTNEST_EGRESS_DATABASE_URL".to_owned(),
            "postgres://localhost/egress".to_owned(),
        ),
        (
            "ANTNEST_EGRESS_UDP_ADVERTISE".to_owned(),
            "[2001:db8::1]:8092".to_owned(),
        ),
        (
            "ANTNEST_EGRESS_DNS_UPSTREAM".to_owned(),
            "10.20.0.53:53".to_owned(),
        ),
    ]);

    assert_eq!(
        Config::from_values(values),
        Err(ConfigError::Invalid("ANTNEST_EGRESS_UDP_ADVERTISE"))
    );
}

#[test]
fn advertised_endpoint_must_be_usable_unicast_with_a_port() {
    for endpoint in ["10.20.0.8:0", "224.0.0.1:8092", "255.255.255.255:8092"] {
        let values = HashMap::from([
            (
                "ANTNEST_EGRESS_DATABASE_URL".to_owned(),
                "postgres://localhost/egress".to_owned(),
            ),
            (
                "ANTNEST_EGRESS_UDP_ADVERTISE".to_owned(),
                endpoint.to_owned(),
            ),
            (
                "ANTNEST_EGRESS_DNS_UPSTREAM".to_owned(),
                "10.20.0.53:53".to_owned(),
            ),
        ]);

        assert_eq!(
            Config::from_values(values),
            Err(ConfigError::InvalidAdvertisedEndpoint),
            "{endpoint}"
        );
    }
}

#[test]
fn database_advertised_endpoint_and_dns_upstream_are_required() {
    assert_eq!(
        Config::from_values(HashMap::new()),
        Err(ConfigError::Missing("ANTNEST_EGRESS_DATABASE_URL"))
    );
    assert_eq!(
        Config::from_values(HashMap::from([
            (
                "ANTNEST_EGRESS_DATABASE_URL".to_owned(),
                "postgres://localhost/egress".to_owned(),
            ),
            (
                "ANTNEST_EGRESS_UDP_ADVERTISE".to_owned(),
                "0.0.0.0:8092".to_owned(),
            ),
        ])),
        Err(ConfigError::UnspecifiedAdvertisedEndpoint)
    );
    assert_eq!(
        Config::from_values(HashMap::from([
            (
                "ANTNEST_EGRESS_DATABASE_URL".to_owned(),
                "postgres://localhost/egress".to_owned(),
            ),
            (
                "ANTNEST_EGRESS_UDP_ADVERTISE".to_owned(),
                "10.20.0.8:8092".to_owned(),
            ),
        ])),
        Err(ConfigError::Missing("ANTNEST_EGRESS_DNS_UPSTREAM"))
    );
}

#[test]
fn resolver_must_be_a_usable_address_inside_the_pool() {
    let values = HashMap::from([
        (
            "ANTNEST_EGRESS_DATABASE_URL".to_owned(),
            "postgres://localhost/egress".to_owned(),
        ),
        (
            "ANTNEST_EGRESS_UDP_ADVERTISE".to_owned(),
            "10.20.0.8:8092".to_owned(),
        ),
        (
            "ANTNEST_EGRESS_RESOLVER_IPV4".to_owned(),
            "192.0.2.1".to_owned(),
        ),
    ]);

    assert_eq!(
        Config::from_values(values),
        Err(ConfigError::InvalidAddressPool)
    );
}

#[test]
fn health_is_loopback_only_and_control_never_uses_the_packet_address() {
    let base = HashMap::from([
        (
            "ANTNEST_EGRESS_DATABASE_URL".to_owned(),
            "postgres://localhost/egress".to_owned(),
        ),
        (
            "ANTNEST_EGRESS_UDP_ADVERTISE".to_owned(),
            "10.20.0.8:8092".to_owned(),
        ),
        (
            "ANTNEST_EGRESS_DNS_UPSTREAM".to_owned(),
            "10.20.0.53:53".to_owned(),
        ),
    ]);
    for endpoint in ["10.20.0.8:8081", "10.20.0.8:8092"] {
        let mut values = base.clone();
        values.insert("ANTNEST_EGRESS_CONTROL_LISTEN".into(), endpoint.into());
        assert_eq!(
            Config::from_values(values),
            Err(ConfigError::Invalid("ANTNEST_EGRESS_CONTROL_LISTEN"))
        );
    }
    for endpoint in [
        "0.0.0.0:8082",
        "10.20.0.8:8082",
        "[::1]:8082",
        "127.0.0.1:0",
        "127.0.0.1:8081",
    ] {
        let mut values = base.clone();
        values.insert("ANTNEST_EGRESS_HEALTH_LISTEN".into(), endpoint.into());
        assert_eq!(
            Config::from_values(values),
            Err(ConfigError::Invalid("ANTNEST_EGRESS_HEALTH_LISTEN"))
        );
    }
}
