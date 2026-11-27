//! Isolated signed fixtures only. Ephemeral private keys stay in process memory, never in Git/logs.
use std::{io::{Cursor, Write}, sync::Mutex};
use base64::{engine::general_purpose::STANDARD, Engine};
use ring::{rand::SystemRandom, signature::{Ed25519KeyPair, KeyPair}};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zdeck_plugin_host::{plugin::PluginRegistry, plugin_install::PluginInstall, registry_release::*};

struct Fixture { resolver: Resolver, key: Ed25519KeyPair, bytes: Vec<u8>, payload: Value }
impl Fixture {
    fn new() -> Self {
        let key = Ed25519KeyPair::from_pkcs8(Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap().as_ref()).unwrap();
        let keys = json!([{"id":"fixture-only", "publicKey":STANDARD.encode(key.public_key().as_ref())}]).to_string();
        let resolver = Resolver::configured(Some("https://registry.example.test/v1/"), Some(&keys)).unwrap();
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in [("manifest.json", br#"{"id":"fixture","version":"1.2.3","protocolVersion":1,"actions":[{"id":"test","title":"Test","config":{}}]}"#.as_slice()), ("main.js", b"throw new Error('NEVER EXECUTE');".as_slice())] {
            zip.start_file(name, zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored)).unwrap(); zip.write_all(bytes).unwrap();
        }
        let bytes = zip.finish().unwrap().into_inner();
        let payload = json!({"schema":1,"id":"fixture","version":"1.2.3", "artifact":{"url":"https://artifacts.example.test/fixture-1.2.3.zdx","sha256":format!("{:x}", Sha256::digest(&bytes)),"bytes":bytes.len()},"compatibility":{"protocol":1,"runtime":"node","minimum":"22.18.0","platforms":["macos","windows","linux"]},"source":{"repo":"https://source.example.test/fixture","commit":"a".repeat(40),"license":"MIT"}});
        Self { resolver, key, bytes, payload }
    }
    fn sign_bytes(&self, payload: &[u8]) -> Vec<u8> { let mut message = DOMAIN.to_vec(); message.extend_from_slice(payload); serde_json::to_vec(&json!({"schema":1,"keyId":"fixture-only","payload":STANDARD.encode(payload),"signature":STANDARD.encode(self.key.sign(&message).as_ref())})).unwrap() }
    fn sign(&self, payload: &Value) -> Vec<u8> { self.sign_bytes(&serde_json::to_vec(payload).unwrap()) }
    fn verify(&self, payload: &Value) -> Result<VerifiedRelease, &'static str> { self.resolver.verify(&self.sign(payload), "fixture", "1.2.3", std::env::consts::OS) }
}
struct Fake { responses: Mutex<Vec<Result<Vec<u8>, &'static str>>>, calls: Mutex<Vec<(String, usize, String)>> }
impl Fake { fn new(responses: Vec<Result<Vec<u8>, &'static str>>) -> Self { Self { responses: Mutex::new(responses.into_iter().rev().collect()), calls: Mutex::new(vec![]) } } }
impl ReleaseHttp for Fake {
    async fn get(&self, url: url::Url, cap: usize, content_type: &'static str) -> Result<Vec<u8>, &'static str> {
        self.calls.lock().unwrap().push((url.to_string(), cap, content_type.into()));
        self.responses.lock().unwrap().pop().expect("unexpected network request")
    }
}
#[tokio::test]
async fn signed_lookup_download_review_install_is_isolated_disabled_untrusted_and_collision_safe() {
    let f = Fixture::new(); let http = Fake::new(vec![Ok(f.sign(&f.payload)), Ok(f.bytes.clone()), Ok(f.bytes.clone())]);
    let temp = tempfile::tempdir().unwrap(); let directory = temp.path().join("config/plugins");
    let install = PluginInstall::new(directory.clone(), vec![]).unwrap();
    let verified = f.resolver.lookup_with(&http, "fixture", "1.2.3").await.unwrap();
    assert!(!directory.exists()); assert_eq!(http.calls.lock().unwrap().len(), 1);
    let prepared = verified.download_with(&http, &install).await.unwrap();
    assert!(!directory.exists()); let token = prepared.review().review_id.clone();
    assert_eq!(prepared.review().archive_sha256, f.payload["artifact"]["sha256"]);
    let registry = PluginRegistry::default(); install.install_archive(&registry, prepared, &token).await.unwrap();
    assert!(registry.snapshots().await.is_empty());
    assert_eq!(std::fs::read(directory.join("fixture/main.js")).unwrap(), b"throw new Error('NEVER EXECUTE');");
    let catalog = install.catalog().await.unwrap(); assert!(!catalog.plugins[0].trusted);
    let restarted = PluginInstall::new(directory.clone(), vec![]).unwrap(); restarted.restore(&registry).await.unwrap(); assert!(registry.snapshots().await.is_empty());
    let preferences: Value = serde_json::from_slice(&std::fs::read(temp.path().join("config/plugin-trust.v1.json")).unwrap()).unwrap(); assert_eq!(preferences["enabled"], json!({}));
    let collision = verified.download_with(&http, &install).await.unwrap(); assert!(collision.review().collision);
    let token = collision.review().review_id.clone(); assert!(install.install_archive(&registry, collision, &token).await.is_err());
    assert_eq!(http.calls.lock().unwrap()[0], ("https://registry.example.test/v1/releases/fixture/1.2.3.json".into(), METADATA_LIMIT, "application/json".into()));
    assert_eq!(http.calls.lock().unwrap()[1].1, f.bytes.len());
}
#[test]
fn node_signed_public_only_interop_fixture_verifies_in_rust() {
    let f: Value = serde_json::from_str(include_str!("fixtures/ed25519-public-fixture.json")).unwrap();
    let keys = f["trust"]["keys"].to_string();
    let resolver = Resolver::configured(f["trust"]["endpoint"].as_str(), Some(&keys)).unwrap();
    let verified = resolver.verify(&serde_json::to_vec(&f["envelope"]).unwrap(), "fixture", "1.2.3", std::env::consts::OS).unwrap();
    assert_eq!(verified.release().source.repo, "https://source.example.test/fixture-only");
}
#[test]
fn rejects_tampering_unknown_fields_algorithms_identity_compatibility_and_sources() {
    let f = Fixture::new(); assert!(f.verify(&f.payload).is_ok());
    for (pointer, value) in [
        ("/schema", json!(2)), ("/id", json!("other")), ("/version", json!("1.2.4")), ("/version", json!("latest")),
        ("/artifact/url", json!("http://evil.test/a.zdx")), ("/artifact/url", json!("https://127.0.0.1/a.zdx")), ("/artifact/url", json!("https://evil.test/a.zip")),
        ("/artifact/sha256", json!("A".repeat(64))), ("/artifact/bytes", json!(0)), ("/artifact/bytes", json!(ARCHIVE_LIMIT + 1)),
        ("/compatibility/protocol", json!(2)), ("/compatibility/runtime", json!("shell")), ("/compatibility/minimum", json!("99.0.0")),
        ("/compatibility/platforms", json!([])), ("/compatibility/platforms", json!(["linux","linux"])), ("/compatibility/platforms", json!(["unknown"])),
        ("/source/commit", json!("dev")), ("/source/license", json!("\nsecret")), ("/source/repo", json!("file:///etc/passwd")),
    ] { let mut p = f.payload.clone(); *p.pointer_mut(pointer).unwrap() = value; assert!(f.verify(&p).is_err(), "{pointer}"); }
    for part in ["", "artifact", "compatibility", "source"] { let mut p = f.payload.clone(); let o = if part.is_empty() { &mut p } else { &mut p[part] }; o.as_object_mut().unwrap().insert("unknown".into(), json!(true)); assert!(f.verify(&p).is_err()); }
    let signed = f.sign(&f.payload); let envelope: Value = serde_json::from_slice(&signed).unwrap();
    for (field, value) in [("schema", json!(2)), ("keyId", json!("not-trusted")), ("payload", json!(STANDARD.encode(b"{}"))), ("signature", json!(STANDARD.encode([0u8;64]))), ("algorithm", json!("none"))] {
        let mut v = envelope.clone(); v[field] = value; assert!(f.resolver.verify(&serde_json::to_vec(&v).unwrap(), "fixture", "1.2.3", std::env::consts::OS).is_err());
    }
    assert!(f.resolver.verify(&signed, "other", "1.2.3", "linux").is_err());
    assert!(f.resolver.verify(&signed, "fixture", "1.2.4", "linux").is_err());
    assert!(f.resolver.verify(&signed, "fixture", "1.2.3", "unsupported-os").is_err());
    assert!(f.resolver.verify(&vec![b' ';METADATA_LIMIT+1], "fixture", "1.2.3", "linux").is_err());
    let duplicate = String::from_utf8(serde_json::to_vec(&f.payload).unwrap()).unwrap().replacen("\"schema\":1", "\"schema\":1,\"schema\":1", 1);
    assert!(f.resolver.verify(&f.sign_bytes(duplicate.as_bytes()), "fixture", "1.2.3", "linux").is_err());
    let duplicate = String::from_utf8(signed.clone()).unwrap().replacen("\"schema\":1", "\"schema\":1,\"schema\":1", 1);
    assert!(f.resolver.verify(duplicate.as_bytes(), "fixture", "1.2.3", "linux").is_err());
    // Key rotation accepts either explicitly built-in key; removing it is manual revocation.
    let config = json!([{"id":"new-key", "publicKey":STANDARD.encode(f.key.public_key().as_ref())},{"id":"fixture-only", "publicKey":STANDARD.encode(f.key.public_key().as_ref())}]).to_string();
    assert!(Resolver::configured(Some("https://registry.example.test/"), Some(&config)).unwrap().verify(&signed,"fixture","1.2.3","linux").is_ok());
    let revoked = config.replace("fixture-only", "old-revoked");
    assert!(Resolver::configured(Some("https://registry.example.test/"), Some(&revoked)).unwrap().verify(&signed,"fixture","1.2.3","linux").is_err());
}
#[tokio::test]
async fn download_rejects_bad_size_digest_archive_and_manifest_without_publishing() {
    let f = Fixture::new(); let temp = tempfile::tempdir().unwrap(); let directory = temp.path().join("config/plugins"); let install = PluginInstall::new(directory.clone(), vec![]).unwrap();
    let verified = f.verify(&f.payload).unwrap();
    for bytes in [b"not zip".to_vec(), f.bytes[..f.bytes.len()-1].to_vec(), {let mut b=f.bytes.clone(); b[0]^=1; b}, vec![0;f.bytes.len()+1]] {
        assert!(verified.download_with(&Fake::new(vec![Ok(bytes)]), &install).await.is_err());
    }
    for pointer in ["/id", "/version", "/compatibility/runtime"] {
        let mut p = f.payload.clone(); let (id, version) = match pointer {
            "/id" => { p["id"] = json!("other"); ("other", "1.2.3") },
            "/version" => { p["version"] = json!("9.9.9"); ("fixture", "9.9.9") },
            _ => { p["compatibility"]["runtime"] = json!("python"); p["compatibility"]["minimum"] = json!("3.10.0"); ("fixture", "1.2.3") }
        };
        let v = f.resolver.verify(&f.sign(&p), id, version, std::env::consts::OS).unwrap();
        assert!(v.download_with(&Fake::new(vec![Ok(f.bytes.clone())]), &install).await.is_err());
    }
    let mut p = f.payload.clone(); let bad_zip = b"PK\x03\x04not a valid ZIP".to_vec();
    p["artifact"]["sha256"] = json!(format!("{:x}", Sha256::digest(&bad_zip))); p["artifact"]["bytes"] = json!(bad_zip.len());
    assert!(f.verify(&p).unwrap().download_with(&Fake::new(vec![Ok(bad_zip)]), &install).await.is_err());
    assert!(!directory.exists());
    let http = Fake::new(vec![Err("Fixture timeout")]); assert!(f.resolver.lookup_with(&http,"fixture","1.2.3").await.is_err()); assert_eq!(http.calls.lock().unwrap().len(),1);
    assert!(verified.download_with(&Fake::new(vec![Err("Fixture interrupted transfer")]), &install).await.is_err());
    let prepared = verified.download_with(&Fake::new(vec![Ok(f.bytes)]), &install).await.unwrap(); drop(prepared); assert!(!directory.exists());
}
#[test]
fn trust_config_fixed_paths_and_public_network_policy_fail_closed() {
    assert!(Resolver::configured(None,None).is_err());
    for url in ["http://example.test/", "https://localhost/", "https://example.local/", "https://127.1/", "https://[::1]/", "https://[::ffff:8.8.8.8]/", "https://user:secret@example.test/", "https://@example.test/", "https://example.test/?", "https://example.test/#", "https://example.test:444/", "https://example.test/no-slash", "https://example.test/\\evil"] { assert!(Resolver::configured(Some(url),Some("[]")).is_err()); }
    let f=Fixture::new();
    for keys in ["[]", "{}", "garbage", "[{\"id\":\"x\",\"publicKey\":\"garbage\"}]"] { assert!(Resolver::configured(Some("https://registry.example.test/"),Some(keys)).is_err()); }
    for id in ["../escape", "other/path", "A", "", "/tmp/test"] { assert!(f.resolver.lookup_url(id,"1.2.3").is_err()); }
    for version in ["latest", "1.2.3?url=evil", "1.2.3#fragment", "1.2.3-pre"] { assert!(f.resolver.lookup_url("fixture",version).is_err()); }
    for ip in ["0.0.0.0","10.1.2.3","100.64.1.1","127.0.0.2","169.254.169.254","172.16.1.1","192.168.1.1","192.0.2.1","198.18.0.1","198.51.100.1","203.0.113.1","224.0.0.1","255.255.255.255","::","::1","::ffff:127.0.0.1","fc00::1","fe80::1","2001:db8::1","2002:7f00:1::","3fff::1"] { assert!(!public_ip(ip.parse().unwrap()),"{ip}"); }
    for ip in ["8.8.8.8","1.1.1.1","2606:4700:4700::1111"] { assert!(public_ip(ip.parse().unwrap()),"{ip}"); }
}
