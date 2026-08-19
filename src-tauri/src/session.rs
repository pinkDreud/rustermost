use mattermost_api::client::Mattermost;
use std::sync::Mutex;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct Session {
    pub base_url: String,
    pub token: String,
}

pub struct AppState {
    pub session: Mutex<Option<Session>>,
    pub session_m: Mutex<Option<Mattermost>>,
    pub channels: Mutex<Vec<crate::models::Channel>>,
    pub ws_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    pub cache_dir: std::path::PathBuf,
    pub data_dir: std::path::PathBuf,
}

impl AppState {
    pub fn current_session(&self) -> Result<Session, crate::error::AppError> {
        let guard = self.session.lock().unwrap();
        guard.clone().ok_or(crate::error::AppError::NotLoggedIn)
    }
    pub fn current_client(&self) -> Result<Mattermost, crate::error::AppError> {
        let guard = self.session_m.lock().unwrap();
        guard.clone().ok_or(crate::error::AppError::NotLoggedIn)
    }
}
