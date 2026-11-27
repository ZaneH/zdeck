//! Build-owned release trust. Signatures authenticate exact bytes, never reserialized JSON.
use std::{collections::BTreeMap, future::Future, net::{IpAddr, SocketAddr}, time::Duration};
use base64::{engine::general_purpose::STANDARD, Engine};
use ring::signature::{UnparsedPublicKey, ED25519};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;
use crate::plugin_install::{PluginInstall, PluginRuntime, PreparedArchive};

pub const DOMAIN: &[u8] = b"zdeck-release-v1\0";
pub const METADATA_LIMIT: usize = 32 * 1024;
pub const ARCHIVE_LIMIT: usize = 16 * 1024 * 1024;
const INVALID: &str = "The signed registry release is invalid, unsupported or does not match this request. Nothing was installed.";
const NETWORK: &str = "The registry request failed. Check connectivity and immutable HTTPS hosting; redirects are not supported. Nothing was installed.";
pub const UNAVAILABLE: &str = "Registry install requests are unavailable: configure a valid HTTPS release endpoint and independently trusted public keys in this desktop build. Nothing was downloaded or installed.";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Artifact { pub url: String, pub sha256: String, pub bytes: usize }
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Compatibility { pub protocol: u8, pub runtime: String, pub minimum: String, pub platforms: Vec<String> }
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Source { pub repo: String, pub commit: String, pub license: String }
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Release { pub schema: u8, pub id: String, pub version: String, pub artifact: Artifact, pub compatibility: Compatibility, pub source: Source }
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Envelope { schema: u8, key_id: String, payload: String, signature: String }
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PublicKey { id: String, public_key: String }
#[derive(Clone)]
pub struct Resolver { endpoint: Url, keys: BTreeMap<String, Vec<u8>> }
#[derive(Clone)]
pub struct VerifiedRelease { release: Release, key_id: String }
impl VerifiedRelease {
    pub fn release(&self) -> &Release { &self.release }
    pub fn key_id(&self) -> &str { &self.key_id }
}
pub fn valid_id(s: &str) -> bool { !s.is_empty() && s.len() <= 64 && s.as_bytes()[0].is_ascii_lowercase() && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') }
pub fn valid_version(s: &str) -> bool { s.split('.').count() == 3 && s.split('.').all(|p| !p.is_empty() && p.len() <= 4 && p.bytes().all(|b| b.is_ascii_digit())) }
fn hex(s: &str, length: usize) -> bool { s.len() == length && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }
fn key_id(s: &str) -> bool { !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') }

// Conservative public-unicast allowlist. Reject mixed DNS answers rather than choosing a safe one.
pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => { let [a,b,c,_] = ip.octets();
            !matches!(a, 0 | 10 | 127 | 224..=255) && !(a == 100 && (64..=127).contains(&b))
                && !(a == 169 && b == 254) && !(a == 172 && (16..=31).contains(&b))
                && !(a == 192 && (b == 0 || b == 168 || (b == 88 && c == 99)))
                && !(a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                && !(a == 203 && b == 0 && c == 113)
        }
        IpAddr::V6(ip) => { let s = ip.segments();
            (s[0] & 0xe000) == 0x2000 && !(s[0] == 0x2001 && s[1] <= 0x1ff)
                && !(s[0] == 0x2001 && s[1] == 0xdb8) && s[0] != 0x2002 && !(s[0] == 0x3fff && s[1] <= 0xfff)
        }
    }
}
pub fn safe_url(value: &str) -> Result<Url, &'static str> {
    if value.is_empty() || value.len() > 2048 || !value.is_ascii() || value.contains(['\\', '@']) || value.bytes().any(|b| b.is_ascii_control() || b.is_ascii_whitespace()) { return Err(INVALID); }
    let url = Url::parse(value).map_err(|_| INVALID)?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() || url.query().is_some() || url.port().is_some_and(|p| p != 443) { return Err(INVALID); }
    match url.host().ok_or(INVALID)? {
        url::Host::Ipv4(ip) if !public_ip(ip.into()) => return Err(INVALID),
        url::Host::Ipv6(ip) if !public_ip(ip.into()) => return Err(INVALID),
        url::Host::Domain(host) => { let host = host.trim_end_matches('.');
            if !host.contains('.') || ["localhost", "local", "internal", "home", "lan"].iter().any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}"))) { return Err(INVALID); }
        }
        _ => ()
    }
    Ok(url)
}
impl Resolver {
    pub fn configured(endpoint: Option<&str>, keys: Option<&str>) -> Result<Self, &'static str> {
        let endpoint = safe_url(endpoint.ok_or(UNAVAILABLE)?).map_err(|_| UNAVAILABLE)?;
        if !endpoint.path().ends_with('/') { return Err(UNAVAILABLE); }
        let input = keys.filter(|s| s.len() <= 4096).ok_or(UNAVAILABLE)?;
        let keys: Vec<PublicKey> = serde_json::from_str(input).map_err(|_| UNAVAILABLE)?;
        if keys.is_empty() || keys.len() > 8 { return Err(UNAVAILABLE); }
        let mut trusted = BTreeMap::new();
        for key in keys {
            let bytes = STANDARD.decode(&key.public_key).map_err(|_| UNAVAILABLE)?;
            if !key_id(&key.id) || bytes.len() != 32 || trusted.insert(key.id, bytes).is_some() { return Err(UNAVAILABLE); }
        }
        Ok(Self { endpoint, keys: trusted })
    }
    pub fn lookup_url(&self, id: &str, version: &str) -> Result<Url, &'static str> {
        if !valid_id(id) || !valid_version(version) { return Err(INVALID); }
        self.endpoint.join(&format!("releases/{id}/{version}.json")).map_err(|_| INVALID)
    }
    pub fn verify(&self, bytes: &[u8], id: &str, version: &str, platform: &str) -> Result<VerifiedRelease, &'static str> {
        if bytes.len() > METADATA_LIMIT || !valid_id(id) || !valid_version(version) { return Err(INVALID); }
        let envelope: Envelope = serde_json::from_slice(bytes).map_err(|_| INVALID)?;
        if envelope.schema != 1 { return Err(INVALID); }
        let key = self.keys.get(&envelope.key_id).ok_or(INVALID)?;
        let payload = STANDARD.decode(envelope.payload).map_err(|_| INVALID)?;
        let signature = STANDARD.decode(envelope.signature).map_err(|_| INVALID)?;
        let mut message = DOMAIN.to_vec(); message.extend_from_slice(&payload);
        UnparsedPublicKey::new(&ED25519, key).verify(&message, &signature).map_err(|_| INVALID)?;
        let release: Release = serde_json::from_slice(&payload).map_err(|_| INVALID)?;
        let c = &release.compatibility;
        if release.schema != 1 || release.id != id || release.version != version
            || release.artifact.bytes == 0 || release.artifact.bytes > ARCHIVE_LIMIT || !hex(&release.artifact.sha256, 64)
            || !safe_url(&release.artifact.url)?.path().ends_with(".zdx") || c.protocol != 1
            || !matches!((c.runtime.as_str(), c.minimum.as_str()), ("node", "22.18.0") | ("python", "3.10.0"))
            || c.platforms.is_empty() || c.platforms.len() > 3 || !c.platforms.iter().any(|p| p == platform)
            || c.platforms.iter().any(|p| !["macos", "windows", "linux"].contains(&p.as_str()))
            || c.platforms.iter().collect::<std::collections::HashSet<_>>().len() != c.platforms.len()
            || !hex(&release.source.commit, 40) || release.source.license.is_empty() || release.source.license.len() > 40
            || release.source.license.chars().any(char::is_control) { return Err(INVALID); }
        safe_url(&release.source.repo)?;
        Ok(VerifiedRelease { release, key_id: envelope.key_id })
    }
    pub async fn lookup(&self, id: &str, version: &str) -> Result<VerifiedRelease, &'static str> {
        self.lookup_with(&Https, id, version).await
    }
    pub async fn lookup_with(&self, http: &impl ReleaseHttp, id: &str, version: &str) -> Result<VerifiedRelease, &'static str> {
        let bytes = http.get(self.lookup_url(id, version)?, METADATA_LIMIT, "application/json").await?;
        self.verify(&bytes, id, version, std::env::consts::OS)
    }
}
// Test clients replace transport, not HTTPS/DNS/TLS rules of the production client.
pub trait ReleaseHttp: Sync {
    fn get(&self, url: Url, cap: usize, content_type: &'static str) -> impl Future<Output = Result<Vec<u8>, &'static str>> + Send;
}
pub struct Https;
impl ReleaseHttp for Https {
    async fn get(&self, url: Url, cap: usize, content_type: &'static str) -> Result<Vec<u8>, &'static str> {
        tokio::time::timeout(Duration::from_secs(60), async {
            let url = safe_url(url.as_str())?;
            let host = url.host_str().ok_or(NETWORK)?;
            let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host.trim_matches(['[', ']']), 443)).await.map_err(|_| NETWORK)?.collect();
            validate_addresses(&addresses)?;
            // Pin validated DNS results for this request, preserving the hostname for TLS/SNI.
            let client = reqwest::Client::builder().https_only(true).no_proxy().redirect(reqwest::redirect::Policy::none())
                .referer(false).connect_timeout(Duration::from_secs(10)).timeout(Duration::from_secs(50))
                .resolve_to_addrs(host, &addresses).build().map_err(|_| NETWORK)?;
            let response = client.get(url).header("Accept", content_type).send().await.map_err(|_| NETWORK)?;
            read_response(response, cap, content_type).await
        }).await.map_err(|_| NETWORK)?
    }
}
fn validate_addresses(addresses: &[SocketAddr]) -> Result<(), &'static str> {
    if addresses.is_empty() || addresses.len() > 32 || addresses.iter().any(|a| !public_ip(a.ip())) { return Err(NETWORK); }
    Ok(())
}
async fn read_response(mut response: reqwest::Response, cap: usize, content_type: &str) -> Result<Vec<u8>, &'static str> {
    let headers = response.headers();
    if response.status() != reqwest::StatusCode::OK
        || headers.get("content-type").and_then(|h| h.to_str().ok()).and_then(|s| s.split(';').next()).map(str::trim) != Some(content_type)
        || headers.contains_key("content-encoding") || response.content_length().is_some_and(|n| n > cap as u64) { return Err(NETWORK); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| NETWORK)? {
        if chunk.len() > cap.saturating_sub(bytes.len()) { return Err(NETWORK); }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
impl VerifiedRelease {
    pub async fn download(&self, install: &PluginInstall) -> Result<PreparedArchive, String> { self.download_with(&Https, install).await }
    pub async fn download_with(&self, http: &impl ReleaseHttp, install: &PluginInstall) -> Result<PreparedArchive, String> {
        let a = &self.release.artifact;
        let bytes = http.get(safe_url(&a.url)?, a.bytes, "application/zip").await?;
        if bytes.len() != a.bytes || format!("{:x}", Sha256::digest(&bytes)) != a.sha256 { return Err("The downloaded archive does not match the signed size and SHA-256. Nothing was installed.".into()); }
        let prepared = install.inspect_archive_bytes(bytes).await.map_err(|e| e.hint.to_owned())?;
        let r = prepared.review();
        let runtime = match r.runtime { PluginRuntime::Node => "node", PluginRuntime::Python => "python" };
        if r.id != self.release.id || r.version != self.release.version || r.protocol_version != self.release.compatibility.protocol || runtime != self.release.compatibility.runtime { return Err("The archive manifest does not match the signed release. Nothing was installed.".into()); }
        Ok(prepared)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::stream;
    fn response(status: u16, mime: &str, length: Option<u64>, chunks: Vec<Result<Vec<u8>, std::io::Error>>) -> reqwest::Response {
        let mut builder = http::Response::builder().status(status).header("content-type", mime);
        if let Some(n) = length { builder = builder.header("content-length", n); }
        builder.body(reqwest::Body::wrap_stream(stream::iter(chunks))).unwrap().into()
    }
    #[tokio::test]
    async fn transport_rejects_redirects_wrong_content_encoding_and_stream_caps_even_without_honest_lengths() {
        for status in [301, 302, 307, 308, 404, 500] {
            assert!(read_response(response(status,"application/json",None,vec![Ok(b"{}".to_vec())]),100,"application/json").await.is_err());
        }
        for mime in ["text/html", "application/octet-stream", "application/jsonp", ""] {
            assert!(read_response(response(200,mime,None,vec![Ok(b"{}".to_vec())]),100,"application/json").await.is_err());
        }
        for length in [None, Some(1), Some(101)] {
            assert!(read_response(response(200,"application/json",length,vec![Ok(vec![b' ';60]),Ok(vec![b' ';60])]),100,"application/json").await.is_err());
        }
        let encoded: reqwest::Response = http::Response::builder().status(200).header("content-type","application/json").header("content-encoding","gzip").body("{}").unwrap().into();
        assert!(read_response(encoded,100,"application/json").await.is_err());
        assert!(read_response(response(200,"application/zip",None,vec![Err(std::io::Error::other("fixture interrupted transfer"))]),100,"application/zip").await.is_err());
        assert_eq!(read_response(response(200,"application/json; charset=utf-8",None,vec![Ok(b"{".to_vec()),Ok(b"}".to_vec())]),2,"application/json").await.unwrap(),b"{}");
    }
    #[test]
    fn mixed_private_dns_and_empty_or_excess_answers_are_rejected_before_connect() {
        let public: SocketAddr = "8.8.8.8:443".parse().unwrap();
        assert!(validate_addresses(&[public]).is_ok());
        assert!(validate_addresses(&[public,"127.0.0.1:443".parse().unwrap()]).is_err());
        assert!(validate_addresses(&[]).is_err()); assert!(validate_addresses(&vec![public;33]).is_err());
    }
}
