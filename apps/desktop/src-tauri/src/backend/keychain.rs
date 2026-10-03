//! Reads studiod's API token from the Keychain: service "AI Studio", account
//! "studiod/api-token" — the same generic-password item the backend's `KeyringSecretStore`
//! (Python `keyring`) creates.

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const KEYRING_SERVICE: &str = "AI Studio";
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const TOKEN_ACCOUNT: &str = "studiod/api-token";

#[cfg(target_os = "macos")]
pub fn read_token() -> Result<String, crate::error::ShellError> {
    use crate::error::ShellError;
    use security_framework::passwords::get_generic_password;

    // OSStatus values from <Security/SecBase.h>.
    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
    const ERR_SEC_USER_CANCELED: i32 = -128;
    const ERR_SEC_AUTH_FAILED: i32 = -25293;
    const ERR_SEC_INTERACTION_NOT_ALLOWED: i32 = -25308;

    match get_generic_password(KEYRING_SERVICE, TOKEN_ACCOUNT) {
        Ok(bytes) => {
            let token = String::from_utf8(bytes)
                .map_err(|_| ShellError::Keychain("belirteç UTF-8 değil".into()))?;
            let token = token.trim().to_owned();
            if token.is_empty() {
                Err(ShellError::TokenMissing)
            } else {
                Ok(token)
            }
        }
        Err(e) => match e.code() {
            ERR_SEC_ITEM_NOT_FOUND => Err(ShellError::TokenMissing),
            ERR_SEC_USER_CANCELED | ERR_SEC_AUTH_FAILED | ERR_SEC_INTERACTION_NOT_ALLOWED => {
                Err(ShellError::KeychainDenied)
            }
            code => Err(ShellError::Keychain(
                e.message().unwrap_or_else(|| format!("OSStatus {code}")),
            )),
        },
    }
}

/// Non-macOS builds (CI/Linux) have no Keychain: accept `AISTUDIO_TOKEN` for manual testing.
#[cfg(not(target_os = "macos"))]
pub fn read_token() -> Result<String, crate::error::ShellError> {
    match std::env::var("AISTUDIO_TOKEN") {
        Ok(token) if !token.trim().is_empty() => Ok(token.trim().to_owned()),
        _ => Err(crate::error::ShellError::TokenMissing),
    }
}
