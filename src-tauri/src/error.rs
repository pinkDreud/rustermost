use mattermost_api::errors::ApiError;

#[derive(Debug)]
pub enum AppError {
    Network(String),
    Tauri(String),
    NotLoggedIn,
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            AppError::Network(msg) => write!(f, "Network error: {}", msg),
            AppError::Tauri(msg) => write!(f, "Tauri error: {}", msg),
            AppError::NotLoggedIn => write!(f, "Missing token/the token is not working - log in?"),
        }
    }
}

impl From<ApiError> for AppError {
    fn from(e: ApiError) -> Self {
        AppError::Network(e.to_string())
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        AppError::Network(e.to_string())
    }
}

impl From<tauri::Error> for AppError {
    fn from(e: tauri::Error) -> Self {
        AppError::Tauri(e.to_string())
    }
}

impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}
