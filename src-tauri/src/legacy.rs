//! One-time cleanup of data left by removed features.
//!
//! Versions up to 1.2.1 stored an OpenAI API key in the OS keychain for the AI co-pilot, which no longer
//! exists. The key would otherwise stay in the user's keychain forever, so it is deleted at startup.

const KEYRING_SERVICE: &str = "br.com.xcloud.cybermonitor";
const KEYRING_USER: &str = "openai_api_key";

/// Deletes the stored OpenAI key, if any. Runs off the main thread: some keychains block while they prompt.
pub fn purge_openai_key() {
    std::thread::spawn(|| {
        let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER) else { return };
        match entry.delete_credential() {
            Ok(()) => log::info!("removed the OpenAI key left by an older version"),
            Err(keyring::Error::NoEntry) => {}
            Err(e) => log::warn!("could not remove the old OpenAI key: {e}"),
        }
    });
}
