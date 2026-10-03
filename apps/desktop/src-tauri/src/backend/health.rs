//! Minimal `GET /health` over loopback HTTP/1.1. studiod's health endpoint is public and tiny,
//! so a dependency-free client keeps the shell small and avoids a TLS stack it never needs.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Health {
    pub version: Option<String>,
}

/// Performs the request and validates the answer (`200` + `{"ok": true}`).
pub fn check_health(port: u16, timeout: Duration) -> Result<Health, String> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect_timeout(&addr, timeout)
        .map_err(|e| format!("bağlantı kurulamadı: {e}"))?;
    stream
        .set_read_timeout(Some(timeout))
        .and_then(|()| stream.set_write_timeout(Some(timeout)))
        .map_err(|e| format!("zaman aşımı ayarlanamadı: {e}"))?;
    let request = format!(
        "GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json\r\nUser-Agent: ai-studio-shell\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("istek gönderilemedi: {e}"))?;
    let mut raw = Vec::with_capacity(512);
    // Cap the read: /health is ~40 bytes; anything huge is not studiod.
    stream
        .take(64 * 1024)
        .read_to_end(&mut raw)
        .map_err(|e| format!("yanıt okunamadı: {e}"))?;
    parse_health_response(&raw)
}

/// Parses a raw HTTP/1.1 response to `GET /health`.
pub fn parse_health_response(raw: &[u8]) -> Result<Health, String> {
    let split = find(raw, b"\r\n\r\n").ok_or("eksik HTTP yanıtı")?;
    let head = std::str::from_utf8(&raw[..split]).map_err(|_| "geçersiz HTTP başlığı")?;
    let body = &raw[split + 4..];
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap_or_default();
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or("geçersiz HTTP durum satırı")?;
    if status != 200 {
        return Err(format!("beklenmeyen HTTP durumu {status}"));
    }
    let chunked = lines.any(|line| {
        let lower = line.to_ascii_lowercase();
        lower.starts_with("transfer-encoding:") && lower.contains("chunked")
    });
    let body = if chunked {
        dechunk(body)?
    } else {
        body.to_vec()
    };
    let value: serde_json::Value = serde_json::from_slice(&body).map_err(|_| "yanıt JSON değil")?;
    if value.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err("motor sağlıklı değil".into());
    }
    Ok(Health {
        version: value
            .get("version")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
    })
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn dechunk(mut body: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    loop {
        let line_end = find(body, b"\r\n").ok_or("bozuk chunked gövde")?;
        let size_text = std::str::from_utf8(&body[..line_end]).map_err(|_| "bozuk chunk boyutu")?;
        let size_text = size_text.split(';').next().unwrap_or_default().trim();
        let size = usize::from_str_radix(size_text, 16).map_err(|_| "bozuk chunk boyutu")?;
        body = &body[line_end + 2..];
        if size == 0 {
            return Ok(out);
        }
        if body.len() < size {
            return Err("eksik chunk".into());
        }
        out.extend_from_slice(&body[..size]);
        body = body.get(size + 2..).ok_or("eksik chunk sonu")?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn accepts_healthy_response() {
        let raw = b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 29\r\n\r\n{\"ok\":true,\"version\":\"0.1.0\"}";
        let health = parse_health_response(raw).expect("healthy");
        assert_eq!(health.version.as_deref(), Some("0.1.0"));
    }

    #[test]
    fn accepts_chunked_response() {
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n6\r\n{\"ok\":\r\n6\r\n true}\r\n0\r\n\r\n";
        assert!(parse_health_response(raw).is_ok());
    }

    #[test]
    fn rejects_unhealthy_responses() {
        assert!(parse_health_response(b"").is_err());
        assert!(parse_health_response(b"HTTP/1.1 200 OK\r\n").is_err());
        assert!(parse_health_response(b"HTTP/1.1 503 Unavailable\r\n\r\n{\"ok\":true}").is_err());
        assert!(parse_health_response(b"HTTP/1.1 200 OK\r\n\r\n{\"ok\":false}").is_err());
        assert!(parse_health_response(b"HTTP/1.1 200 OK\r\n\r\n<html>").is_err());
    }

    #[test]
    fn talks_to_a_local_server() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let server = std::thread::spawn(move || {
            if let Ok((mut conn, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let n = conn.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let body = "{\"ok\":true,\"version\":\"9.9.9\"}";
                let _ = write!(
                    conn,
                    "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                req
            } else {
                String::new()
            }
        });
        let health = check_health(port, Duration::from_secs(2)).expect("healthy");
        assert_eq!(health.version.as_deref(), Some("9.9.9"));
        let req = server.join().expect("join");
        assert!(req.starts_with("GET /health HTTP/1.1\r\n"));
    }

    #[test]
    fn reports_connection_refused() {
        // Bind then drop to get a port that is (almost certainly) closed.
        let port = TcpListener::bind("127.0.0.1:0")
            .and_then(|l| l.local_addr())
            .map(|a| a.port())
            .expect("port");
        assert!(check_health(port, Duration::from_millis(300)).is_err());
    }
}
