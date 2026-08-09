// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use tauri::Manager;
use std::sync::Mutex;
struct AppState {
    token: Mutex<Option<String>>,
}

#[derive(Debug)]
enum AppError {
    Network(String),   
    Tauri(String),     
    NotLoggedIn,
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
struct Team {
    id: String,
    name: String,
    display_name: String,
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
struct Channel {
    id: String,
    #[serde(rename = "type")]
    channel_type: String,
    display_name: String,
    name: String,
}

// 1. Come si stampa (serve per il messaggio leggibile)
impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            AppError::Network(msg) => write!(f, "Network error: {}", msg),
            AppError::Tauri(msg)   => write!(f, "Tauri error: {}", msg),
            AppError::NotLoggedIn  => write!(f, "Missing token/the token is not working - log in?"),
        }
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

#[tauri::command]
fn get_app_status() -> String {
    "Backend Rust is on!".to_string()
}

#[tauri::command]
async fn open_sso_window(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed_url = url.parse::<tauri::Url>().map_err(|e| e.to_string())?;

    tauri::WebviewWindowBuilder::new(&app, "sso-login", tauri::WebviewUrl::External(parsed_url))
        .title("Login SSO")
        .inner_size(500.0, 700.0)
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
async fn capture_token(
    app: tauri::AppHandle,
    url: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let parsed_url =  url.parse::<tauri::Url>().map_err(|e| e.to_string())?;

    let webview = app
        .get_webview_window("sso-login")
        .ok_or("SSO window not found".to_string())?;

    let cookies = webview
        .cookies_for_url(parsed_url)
        .map_err(|e| e.to_string())?;

    let token = cookies
        .iter() 
        .find(|c| c.name() == "MMAUTHTOKEN")
        .ok_or("No token found".to_string())?;

    let token_value = token.value().to_string();

    let mut guard = state.token.lock().map_err(|e| e.to_string())?;

    *guard = Some(token_value.clone());

    Ok(token_value)
}

#[tauri::command]
fn get_stored_token(state: tauri::State<'_, AppState>) -> Option<String> {
    let guard = state.token.lock().unwrap();
    return guard.clone()
}

#[tauri::command]
async fn fetch_me(
    base_url: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, AppError> {
    let token = {
        let guard = state.token.lock().unwrap();
        guard.clone().ok_or(AppError::NotLoggedIn)?
    };

    let url = format!("{}/api/v4/users/me", base_url);

    let client = reqwest::Client::new();
    let resp = client
        .get(url)
        .bearer_auth(token)
        .send()
        .await?;

    let body = resp.json::<serde_json::Value>().await?;

    Ok(body)
}

#[tauri::command]
async fn fetch_teams(
    base_url: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Team>, AppError> {
    let token = {
        let guard = state.token.lock().unwrap();
        guard.clone().ok_or(AppError::NotLoggedIn)?
    };

    let url = format!("{}/api/v4/users/me/teams", base_url);

    let resp = reqwest::Client::new()
        .get(url)
        .bearer_auth(token)
        .send()
        .await?;

    let teams = resp.json::<Vec<Team>>().await?;

    Ok(teams)
}


#[tauri::command]
async fn fetch_channels(
    base_url: String,
    team_id: String,
    state: tauri::State<'_, AppState>
) -> Result<Vec<Channel>, AppError> {
    let token = {
        let guard = state.token.lock().unwrap();
        guard.clone().ok_or(AppError::NotLoggedIn)?
    };


    let url = format!("{}/api/v4/users/me/teams/{}/channels", base_url, team_id);

    let resp = reqwest::Client::new()
        .get(url)
        .bearer_auth(token)
        .send()
        .await?;

    let channels = resp.json::<Vec<Channel>>().await?;

    Ok(channels)
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState { 
            token: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![get_app_status, open_sso_window, capture_token, get_stored_token, fetch_me, fetch_teams, fetch_channels])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
