// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use tauri::Manager;
use std::sync::Mutex;

#[derive(Clone)]
struct Session {
    base_url: String,
    token: String,
}

struct AppState {
    session: Mutex<Option<Session>>,
    channels: Mutex<Vec<Channel>>,
}

impl AppState {
    fn current_session(&self) -> Result<Session, AppError> {
        let guard = self.session.lock().unwrap();
        guard.clone().ok_or(AppError::NotLoggedIn)
    }
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

#[derive(Debug, serde::Deserialize, serde::Serialize, Clone)]
struct Channel {
    id: String,
    #[serde(rename = "type")]
    channel_type: String,
    display_name: String,
    name: String,
}

#[derive(Debug, serde::Serialize)]
struct ChannelGroups {
    chat: Vec<Channel>,
    community: Vec<Channel>
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

#[derive(serde::Serialize, Clone)]
struct IncomingMessage {
    channel_id: String,
    sender: String,
    message: String,
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
async fn capture_session(
    app: tauri::AppHandle,
    base_url: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {


    let parsed_url =  base_url.parse::<tauri::Url>().map_err(|e| e.to_string())?;

    let webview = app
        .get_webview_window("sso-login")
        .ok_or("SSO window not found".to_string())?;

    let cookies = webview
        .cookies_for_url(parsed_url)
        .map_err(|e| e.to_string())?;

    let token_find = cookies
        .iter() 
        .find(|c| c.name() == "MMAUTHTOKEN")
        .ok_or("No token found".to_string())?;

    let token = token_find.value().to_string();

    let mut guard = state.session.lock().unwrap();

    *guard = Some(Session{ base_url, token: token.clone()} );

    Ok(token)
}

#[tauri::command]
async fn fetch_me(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, AppError> {
    let session = state.current_session()?;

    let url = format!("{}/api/v4/users/me", session.base_url);

    let client = reqwest::Client::new();
    let resp = client
        .get(url)
        .bearer_auth(session.token)
        .send()
        .await?;

    let body = resp.json::<serde_json::Value>().await?;

    Ok(body)
}

#[tauri::command]
async fn fetch_teams(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Team>, AppError> {
    let session = state.current_session()?;

    let url = format!("{}/api/v4/users/me/teams", session.base_url);

    let resp = reqwest::Client::new()
        .get(url)
        .bearer_auth(session.token)
        .send()
        .await?;

    let teams = resp.json::<Vec<Team>>().await?;

    Ok(teams)
}


#[tauri::command]
async fn fetch_channels(
    team_id: String,
    state: tauri::State<'_, AppState>
) -> Result<Vec<Channel>, AppError> {
    let session = state.current_session()?;

    let url = format!("{}/api/v4/users/me/teams/{}/channels", session.base_url, team_id);

    let resp = reqwest::Client::new()
        .get(url)
        .bearer_auth(session.token)
        .send()
        .await?;

    let channels = resp.json::<Vec<Channel>>().await?;

    Ok(channels)
}

#[tauri::command]
async fn fetch_grouped_channels(
    team_id : String,
    state: tauri::State<'_, AppState>
) -> Result<ChannelGroups, AppError> {
    let channels = fetch_channels(team_id, state).await?;

    let (chat, community): (Vec<Channel>, Vec<Channel>) = channels
    .into_iter()
    .partition(|c| c.channel_type == "D" || c.channel_type == "G");

    Ok(ChannelGroups { chat, community })

}

async fn channels_for_team(
    base_url: &str,
    token: &str,
    team_id: &str,
) -> Result<Vec<Channel>, AppError> {
    let url = format!("{}/api/v4/users/me/teams/{}/channels", base_url, team_id);
    let resp = reqwest::Client::new()
        .get(url)
        .bearer_auth(token)
        .send()
        .await?;
    Ok(resp.json::<Vec<Channel>>().await?)
}

async fn teams_for(base_url: &str, token: &str) -> Result<Vec<Team>, AppError> {
    let url = format!("{}/api/v4/users/me/teams", base_url);
    let resp = reqwest::Client::new()
        .get(url)
        .bearer_auth(token)
        .send()
        .await?;
    Ok(resp.json::<Vec<Team>>().await?)
}

#[tauri::command]
async fn fetch_all_channels(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Channel>, AppError> {
    let session = state.current_session()?;

    let teams = teams_for(&session.base_url, &session.token).await?;

    let mut all: Vec<Channel> = Vec::new();

    for team in &teams {
        let chans = channels_for_team(&session.base_url, &session.token, &team.id).await?;
        all.extend(chans);
    }

    use std::collections::HashSet;

    let mut seen = HashSet::new();
    all.retain(|c| seen.insert(c.id.clone()));
    
    {
        let mut cache = state.channels.lock().unwrap();
        *cache = all.clone();
    }
    
    Ok(all)
}

#[tauri::command]
fn get_cached_channels(state: tauri::State<'_, AppState>,) -> Vec<Channel> {
    let guard = state.channels.lock().unwrap();
    guard.clone()
}

#[tauri::command]
async fn connect_websocket(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), AppError> {
    use futures_util::{SinkExt, StreamExt};
    use tauri::Emitter;   

    let session = state.current_session()?;

    let ws_url = format!("{}/api/v4/websocket", session.base_url.replace("https://", "wss://"));

    tokio::spawn(
        async move {
        let (ws_stream, _) = match tokio_tungstenite::connect_async(&ws_url).await {
            Ok(ok) => ok,
            Err(e) => { eprintln!("WS connect error: {}", e); return; }
        };

        let (mut write, mut read) = ws_stream.split();

        let auth = serde_json::json!({
            "seq": 1,
            "action": "authentication_challenge",
            "data": { "token": session.token }
        });

        let _ = write.send(tokio_tungstenite::tungstenite::Message::text(auth.to_string())).await;

        while let Some(msg) = read.next().await {
            match msg {
                Ok(m) => {
                    let text = m.to_string();

                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                        if json["event"] == "posted" {
                            if let Some(post_str) = json["data"]["post"].as_str() {
                                if let Ok(post) = serde_json::from_str::<serde_json::Value>(post_str) {
                                    let msg = IncomingMessage {
                                        channel_id: post["channel_id"].as_str().unwrap_or("").to_string(),
                                        sender:     json["data"]["sender_name"].as_str().unwrap_or("").to_string(),
                                        message:    post["message"].as_str().unwrap_or("").to_string(),
                                    };
                                    let _ = app.emit("mm-post", msg);
                                }
                            }
                        }
                    }
                }
                Err(e) => { eprintln!("WS read error: {}", e); break; }
            }
        }
        println!("WS closed");
    });

    Ok(()) 
}


#[tauri::command]
async fn send_message(
    channel_id: String,
    message: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), AppError> {
    let session = state.current_session()?;

    let url = format!("{}/api/v4/posts", session.base_url);

    let body = serde_json::json!({
            "channel_id": channel_id,
            "message": message,
    });

     reqwest::Client::new()
        .post(&url)                    // ← POST, non GET
        .bearer_auth(&session.token)
        .json(&body)                   // ← allega il body JSON
        .send()
        .await?
        .error_for_status()?;          // ← 4xx/5xx diventano errore

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            session: Mutex::new(None),
            channels: Mutex::new(Vec::new()),   // parte vuota
        })
        .invoke_handler(tauri::generate_handler![
            get_app_status, open_sso_window, 
            capture_session,
            fetch_me, fetch_teams, 
            fetch_channels, fetch_grouped_channels,
            fetch_all_channels, get_cached_channels,
            connect_websocket, send_message])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
