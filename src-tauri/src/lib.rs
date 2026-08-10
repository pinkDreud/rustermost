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
    ws_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
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
    team_id: String,
    last_post_at: i64,
    total_msg_count: i64,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, Clone)]
struct ChannelMember {
    channel_id: String,
    msg_count: i64,
    mention_count: i64,
    last_viewed_at: i64,
}

#[derive(serde::Serialize)]
struct ChannelWithMember {
    #[serde(flatten)]
    channel: Channel,
    member: Option<ChannelMember>,
}


#[derive(Debug, serde::Serialize)]
struct ChannelGroups {
    chat: Vec<Channel>,
    community: Vec<Channel>
}


#[derive(serde::Deserialize, serde::Serialize, Clone)]
struct Post {
    id: String,
    message: String,
    user_id: String,
    create_at: i64,
    #[serde(default)]
    file_ids: Vec<String>,
    #[serde(default)]
    metadata: PostMetadata,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, Clone, Default)]
struct PostMetadata {
    #[serde(default)]
    reactions: Vec<Reaction>,
}

#[derive(serde::Deserialize, serde::Serialize, Clone)]
struct FileInfo {
    id: String, 
    name: String, 
    size: i64, 
    mime_type: String
}

#[derive(serde::Deserialize)]
struct PostList {
    order: Vec<String>,
    posts: std::collections::HashMap<String, Post>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, Clone)]
struct CustomEmoji {
    id: String,
    name: String,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, Clone)]
struct Reaction {
    user_id: String,
    post_id: String,
    emoji_name: String,
}


impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            AppError::Network(msg) => write!(f, "Network error: {}", msg),
            AppError::Tauri(msg)   => write!(f, "Tauri error: {}", msg),
            AppError::NotLoggedIn  => write!(f, "Missing token/the token is not working - log in?"),
        }
    }
}

#[derive(serde::Deserialize, serde::Serialize)]
struct MMUser {
    id: String,
    username: String,
    first_name: String,
    last_name: String,
    nickname: String,
}

#[derive(serde::Serialize, Clone)]
struct IncomingMessage {
    id: String,
    file_ids: Vec<String>,
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
async fn get_file_info(
    file_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, AppError> {
    let session = state.current_session()?;

    let url = format!("{}/api/v4/files/{}/info", session.base_url, file_id);

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
async fn get_file_thumbnail(
    file_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, AppError> {
    let session = state.current_session()?;

    let url = format!("{}/api/v4/files/{}/thumbnail", session.base_url, file_id);

    let client = reqwest::Client::new();
    let resp = client
        .get(url)
        .bearer_auth(session.token)
        .send()
        .await?;

    let bytes = resp.bytes().await?;

    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:image/jpeg;base64,{}", b64))
}

#[tauri::command]
async fn get_file(
    file_id: String,
    mime: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, AppError> {
    let session = state.current_session()?;

    let url = format!("{}/api/v4/files/{}", session.base_url, file_id);

    let client = reqwest::Client::new();
    let resp = client
        .get(url)
        .bearer_auth(session.token)
        .send()
        .await?;

    let bytes = resp.bytes().await?;

    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
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
async fn fetch_channel_members( // fetches all the info about the channel
    team_id: String,
    state: tauri::State<'_, AppState>
) -> Result<Vec<ChannelMember>, AppError> {
    let session = state.current_session()?;

    let url = format!("{}/api/v4/users/me/teams/{}/channels/members", session.base_url, team_id);

    let resp = reqwest::Client::new()
        .get(url)
        .bearer_auth(session.token)
        .send()
        .await?;

    let channel_member = resp.json::<Vec<ChannelMember>>().await?;

    Ok(channel_member)
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


async fn members_for_team(
    base_url: &str,
    token: &str,
    team_id: &str,
) -> Result<Vec<ChannelMember>, AppError> {
    let url = format!("{}/api/v4/users/me/teams/{}/channels/members", base_url, team_id);
    let resp = reqwest::Client::new()
        .get(url)
        .bearer_auth(token)
        .send()
        .await?;
    Ok(resp.json::<Vec<ChannelMember>>().await?)
}

#[tauri::command]
async fn fetch_all_channels_with_members(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ChannelWithMember>, AppError> {
    let session = state.current_session()?;

    let teams = teams_for(&session.base_url, &session.token).await?;

    let mut all: Vec<Channel> = Vec::new();
    let mut all_members: Vec<ChannelMember> = Vec::new();

    for team in &teams {
        let chans = channels_for_team(&session.base_url, &session.token, &team.id).await?;
        all.extend(chans);
        let members = members_for_team(&session.base_url, &session.token, &team.id).await?;
        all_members.extend(members);
    }

    use std::collections::{HashMap, HashSet};

    // channels: dedupe DMs that appear in every team
    let mut seen = HashSet::new();
    all.retain(|c| seen.insert(c.id.clone()));

    // members: turn the list into a lookup by channel id (dedupes for free)
    let mut members_by_channel: HashMap<String, ChannelMember> = HashMap::new();
    for m in all_members {
        members_by_channel.insert(m.channel_id.clone(), m);
    }

    // cache while `all` still exists — the merge loop below consumes it
    {
        let mut cache = state.channels.lock().unwrap();
        *cache = all.clone();
    }

    let mut all_with_members: Vec<ChannelWithMember> = Vec::new();
    for chan in all {
        all_with_members.push(ChannelWithMember {
            member: members_by_channel.remove(&chan.id),
            channel: chan,
        });
    }

    Ok(all_with_members)
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
    {
        let mut guard = state.ws_task.lock().unwrap();
        if let Some(h) = guard.take() { h.abort(); }
    }
    let session = state.current_session()?;

    let ws_url = format!("{}/api/v4/websocket", session.base_url.replace("https://", "wss://"));

    let join_handle = tokio::spawn(
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
                                        id: post["id"].as_str().unwrap_or("").to_string(),
                                        file_ids: post["file_ids"].as_array()
                                            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                                            .unwrap_or_default(),
                                    };
                                    let _ = app.emit("mm-post", msg);
                                }
                            }
                        } else if json["event"] == "reaction_added" || json["event"] == "reaction_removed" {
                            if let Some(r_str) = json["data"]["reaction"].as_str() {
                                if let Ok(r) = serde_json::from_str::<serde_json::Value>(r_str) {
                                    let payload = Reaction {
                                        user_id:    r["user_id"].as_str().unwrap_or("").to_string(),
                                        post_id:    r["post_id"].as_str().unwrap_or("").to_string(),
                                        emoji_name: r["emoji_name"].as_str().unwrap_or("").to_string(),
                                    };
                                    let name = if json["event"] == "reaction_added" { "mm-reaction-added" } else { "mm-reaction-removed" };
                                    let _ = app.emit(name, payload);
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
    {
        let mut guard = state.ws_task.lock().unwrap();
        *guard = Some(join_handle);
    }
    Ok(()) 
}


#[tauri::command]
async fn view_channel(
    channel_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), AppError> {
    let session = state.current_session()?;

    let url = format!("{}/api/v4/channels/members/me/view", session.base_url);

    let body = serde_json::json!({
            "channel_id": channel_id,
    });

     reqwest::Client::new()
        .post(&url)
        .bearer_auth(&session.token)
        .json(&body)
        .send()
        .await?
        .error_for_status()?;

    Ok(())
}

#[tauri::command]
async fn send_message(
    channel_id: String,
    message: String,
    file_ids: Option<Vec<String>>,
    state: tauri::State<'_, AppState>,
) -> Result<(), AppError> {
    let session = state.current_session()?;

    let url = format!("{}/api/v4/posts", session.base_url);

    let mut body = serde_json::json!({
            "channel_id": channel_id,
            "message": message,
    });
    if let Some(ids) = file_ids {
        body["file_ids"] = serde_json::json!(ids);
    }

     reqwest::Client::new()
        .post(&url)
        .bearer_auth(&session.token)
        .json(&body)
        .send()
        .await?
        .error_for_status()?;

    Ok(())
}


#[tauri::command]
async fn execute_command(
    channel_id: String,
    team_id: String,
    command: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, AppError> {
    let session = state.current_session()?;

    let url = format!("{}/api/v4/commands/execute", session.base_url);

    let body = serde_json::json!({
        "channel_id": channel_id,
        "command": command,
        "team_id": team_id,
    });    

    let resp = reqwest::Client::new()
        .post(&url)
        .bearer_auth(&session.token)
        .json(&body)
        .send()
        .await?
        .error_for_status()?;

    let answer = resp.json::<serde_json::Value>().await?;
    
    Ok(answer)
}

#[tauri::command]
async fn add_reaction(
    post_id: String,
    emoji_name: String,
    user_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), AppError> {
    let session = state.current_session()?;

    let url = format!("{}/api/v4/reactions", session.base_url);

    let body = Reaction{ user_id, post_id, emoji_name };
    
    reqwest::Client::new()
        .post(&url)
        .bearer_auth(&session.token)
        .json(&body)
        .send()
        .await?
        .error_for_status()?;

    Ok(())
}


#[tauri::command]
async fn remove_reaction(
    post_id: String,
    emoji_name: String,
    user_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), AppError> {
    let session = state.current_session()?;

    let url = format!("{}/api/v4/users/{user_id}/posts/{post_id}/reactions/{emoji_name}", session.base_url);

    reqwest::Client::new()
        .delete(&url)
        .bearer_auth(&session.token)
        .send()
        .await?
        .error_for_status()?;

    Ok(())
}

#[tauri::command]
async fn get_posts(
    channel_id: String,
    before: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Post>, AppError> {
    let session = state.current_session()?;

    let mut url = format!("{}/api/v4/channels/{}/posts?per_page=100", session.base_url, channel_id);
    
    if let Some(id) = before {
        url = format!("{}&before={}", url, id);
    }
    
    let resp = reqwest::Client::new()
        .get(url)
        .bearer_auth(&session.token)
        .send()
        .await?;

    let list = resp.json::<PostList>().await?;

    // 'order' è dal più recente al più vecchio; per la UI vogliamo il contrario
    let posts = list.order
        .iter()
        .rev()                                          // inverti: dal vecchio al nuovo
        .filter_map(|id| list.posts.get(id).cloned())   // id → Post (salta i mancanti)
        .collect();

    Ok(posts)
}

#[tauri::command]
async fn get_avatar(
    user_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, AppError> {
    let session = state.current_session()?;

    let url = format!("{}/api/v4/users/{}/image", session.base_url, user_id);

    let resp = reqwest::Client::new()
        .get(url)
        .bearer_auth(&session.token)
        .send()
        .await?;

    let bytes = resp.bytes().await?;

    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:image/png;base64,{}", b64))
}


#[tauri::command]
async fn get_custom_emojis(
    page: i64,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<CustomEmoji>, AppError> {
    let session = state.current_session()?;

    let url = format!("{}/api/v4/emoji?page={page}&per_page=200&sort=name", session.base_url);

    let resp = reqwest::Client::new()
        .get(url)
        .bearer_auth(&session.token)
        .send()
        .await?;

    let emojis = resp.json::<Vec<CustomEmoji>>().await?;
    
    Ok(emojis)
}

#[tauri::command]
async fn get_emoji_image(
    emoji_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, AppError> {
    let session = state.current_session()?;

    let url = format!("{}/api/v4/emoji/{emoji_id}/image", session.base_url);
    let resp = reqwest::Client::new()
        .get(url)
        .bearer_auth(&session.token)
        .send()
        .await?;

    
    let mime = resp.headers().get(reqwest::header::CONTENT_TYPE)
    .and_then(|v| v.to_str().ok())
    .unwrap_or("image/png")
    .to_string();

    let bytes = resp.bytes().await?;

    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))

}


#[tauri::command]
async fn get_users_by_ids(
    ids: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<MMUser>, AppError> {
    let session = state.current_session()?;

    let url = format!("{}/api/v4/users/ids", session.base_url);

    let resp = reqwest::Client::new()
        .post(url)
        .bearer_auth(&session.token)
        .json(&ids)
        .send()
        .await?;

    let users = resp.json::<Vec<MMUser>>().await?;
    Ok(users)
}


#[tauri::command]
async fn search_users(
    term: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<MMUser>, AppError> {
    let session = state.current_session()?;
    let url = format!("{}/api/v4/users/search", session.base_url);

    let body = serde_json::json!({ "term": term });

    let resp = reqwest::Client::new()
        .post(url)
        .bearer_auth(&session.token)
        .json(&body)
        .send()
        .await?
        .error_for_status()?;

    let users = resp.json::<Vec<MMUser>>().await?;
    Ok(users)
}

#[tauri::command]
async fn create_chat(
    user_ids: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Channel, AppError> {
    let session = state.current_session()?;

    // 2 id → direct message; 3+ → group message.
    let endpoint = if user_ids.len() <= 2 { "direct" } else { "group" };
    let url = format!("{}/api/v4/channels/{}", session.base_url, endpoint);

    let resp = reqwest::Client::new()
        .post(url)
        .bearer_auth(&session.token)
        .json(&user_ids)
        .send()
        .await?
        .error_for_status()?;

    let channel = resp.json::<Channel>().await?;
    Ok(channel)
}

#[tauri::command]
async fn create_named_channel(
    team_id: String,
    name: String,
    display_name: String,
    channel_type: String,
    state: tauri::State<'_, AppState>,
) -> Result<Channel, AppError> {
    let session = state.current_session()?;
    let url = format!("{}/api/v4/channels", session.base_url);

    let body = serde_json::json!({
        "team_id": team_id,
        "name": name,
        "display_name": display_name,
        "type": channel_type,
    });

    let resp = reqwest::Client::new()
        .post(url)
        .bearer_auth(&session.token)
        .json(&body)
        .send()
        .await?
        .error_for_status()?;

    let channel = resp.json::<Channel>().await?;
    Ok(channel)
}
#[tauri::command]
async fn upload_file(
    channel_id: String,
    filename: String,
    data_b64: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, AppError> {
    use base64::Engine;

    #[derive(serde::Deserialize)]
    struct FileUploadResponse {
        file_infos: Vec<FileInfo>,
    }

    let data = base64::engine::general_purpose::STANDARD
        .decode(&data_b64)
        .map_err(|e| AppError::Network(e.to_string()))?;

    let session = state.current_session()?;

    let resp = reqwest::Client::new()
        .post(format!("{}/api/v4/files", session.base_url))
        .query(&[("channel_id", &channel_id), ("filename", &filename)])
        .bearer_auth(&session.token)
        .body(data)
        .send()
        .await?
        .error_for_status()?;

    let parsed = resp.json::<FileUploadResponse>().await?;

    parsed.file_infos.first().map(|f| f.id.clone())
        .ok_or(AppError::Network("upload returned no file info".into()))
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState {
            session: Mutex::new(None),
            channels: Mutex::new(Vec::new()),   // parte vuota
            ws_task:  Mutex::new(None),
        })
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_app_status, open_sso_window, 
            capture_session,
            fetch_me, fetch_teams, 
            fetch_channels, fetch_grouped_channels,
            fetch_all_channels, get_cached_channels,
            connect_websocket, send_message, get_posts, get_users_by_ids, get_avatar, search_users, create_chat, create_named_channel,
            fetch_channel_members, fetch_all_channels_with_members, view_channel,
            get_file_info, get_file_thumbnail, get_file, upload_file,
            get_emoji_image, get_custom_emojis, add_reaction, remove_reaction, execute_command])
        .run(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        });
}
