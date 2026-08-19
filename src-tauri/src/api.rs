use crate::error::AppError;
use crate::models::*;
use crate::session::{AppState, Session};
use tauri::Manager;

use mattermost_api::client::{AuthenticationData, Mattermost};

use crate::atomic_file_write;

#[tauri::command]
pub fn get_app_status() -> String {
    "Backend Rust is on!".to_string()
}

#[tauri::command]
pub async fn get_file_info(
    file_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, crate::error::AppError> {
    let client = state.current_client()?;

    let resp = client
        .query("GET", &format!("files/{file_id}/info"), None, None)
        .await?;

    Ok(resp)
}

#[tauri::command]
pub async fn open_sso_window(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed_url = url.parse::<tauri::Url>().map_err(|e| e.to_string())?;

    tauri::WebviewWindowBuilder::new(&app, "sso-login", tauri::WebviewUrl::External(parsed_url))
        .title("Login SSO")
        .inner_size(500.0, 700.0)
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn capture_session(
    app: tauri::AppHandle,
    base_url: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let parsed_url = base_url.parse::<tauri::Url>().map_err(|e| e.to_string())?;

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
    let mut guard_m = state.session_m.lock().unwrap();

    let auth_data = AuthenticationData::from_access_token(&token);
    let cli = Mattermost::new(base_url.clone(), auth_data).map_err(|e| e.to_string())?;
    *guard_m = Some(cli);

    let session = Session {
        base_url,
        token: token.clone(),
    };
    if let Ok(data) = serde_json::to_string(&session) {
        atomic_file_write(&state.data_dir.join("session.json"), &data);
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&state.data_dir.join("session.json"), std::fs::Permissions::from_mode(0o600));
        }
    }
    
    *guard = Some(session);
    
    Ok(token)
}


#[tauri::command]
pub fn restore_session(
    state: tauri::State<'_, AppState>,
) -> Result<String, AppError> {
    let data = std::fs::read_to_string(state.data_dir.join("session.json"))?;
    let session: Session = serde_json::from_str(&data)?;
    let mut guard = state.session.lock().unwrap();
    let base_url = session.base_url.clone();
    let auth_data = AuthenticationData::from_access_token(&session.token);
    *guard = Some(session);
    let mut guard_c = state.session_m.lock().unwrap();
    let cli = Mattermost::new(base_url.clone(), auth_data)?;
    *guard_c = Some(cli);
    Ok(base_url)
}

#[tauri::command]
pub async fn fetch_me(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, AppError> {
    let client = state.current_client()?;
    let resp = client.query("GET", "users/me", None, None).await?;
    Ok(resp)
}

#[tauri::command]
pub async fn fetch_teams(state: tauri::State<'_, AppState>) -> Result<Vec<Team>, AppError> {
    let client = state.current_client()?;
    let resp = client.query("GET", "users/me/teams", None, None).await?;

    Ok(resp)
}

#[tauri::command]
pub async fn fetch_channels(
    team_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Channel>, AppError> {
    let client = state.current_client()?;
    let resp = client
        .query(
            "GET",
            &format!("users/me/teams/{team_id}/channels"),
            None,
            None,
        )
        .await?;

    Ok(resp)
}

#[tauri::command]
pub async fn fetch_channel_members(
    // fetches all the info about the channel
    team_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ChannelMember>, AppError> {
    let client = state.current_client()?;
    let resp = client
        .query(
            "GET",
            &format!("users/me/teams/{team_id}/channels/members"),
            None,
            None,
        )
        .await?;

    Ok(resp)
}

#[tauri::command]
pub async fn fetch_grouped_channels(
    team_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<ChannelGroups, AppError> {
    let channels = fetch_channels(team_id, state).await?;

    let (chat, community): (Vec<Channel>, Vec<Channel>) = channels
        .into_iter()
        .partition(|c| c.channel_type == "D" || c.channel_type == "G");

    Ok(ChannelGroups { chat, community })
}

#[tauri::command]
pub async fn fetch_all_channels_with_members(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ChannelWithMember>, AppError> {
    let client = state.current_client()?;
    let teams = teams_for(&client).await?;

    let mut all: Vec<Channel> = Vec::new();
    let mut all_members: Vec<ChannelMember> = Vec::new();

    for team in &teams {
        let chans = channels_for_team(&client, &team.id).await?;
        all.extend(chans);
        let members = members_for_team(&client, &team.id).await?;
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
pub fn get_cached_channels(state: tauri::State<'_, AppState>) -> Vec<Channel> {
    let guard = state.channels.lock().unwrap();
    guard.clone()
}

#[tauri::command]
pub fn get_cached_posts(
    channel_id: String,
    state: tauri::State<'_, AppState>
) -> Result<String, AppError> {
    let cache_path = state.cache_dir.join("chat").join(&channel_id);
    Ok(std::fs::read_to_string(&cache_path)?)
}


#[tauri::command]
pub async fn view_channel(
    channel_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), AppError> {
    let client = state.current_client()?;

    let body = serde_json::json!({
        "channel_id": channel_id,
    });
    let _resp: serde_json::Value = client.post("channels/members/me/view", None, &body).await?;

    Ok(())
}

#[tauri::command]
pub async fn send_message(
    channel_id: String,
    message: String,
    file_ids: Option<Vec<String>>,
    state: tauri::State<'_, AppState>,
) -> Result<(), AppError> {
    let client = state.current_client()?;

    let mut body = serde_json::json!({
            "channel_id": channel_id,
            "message": message,
    });
    if let Some(ids) = file_ids {
        body["file_ids"] = serde_json::json!(ids);
    }
    let _resp: serde_json::Value = client.post("posts", None, &body).await?;

    Ok(())
}

#[tauri::command]
pub async fn execute_command(
    channel_id: String,
    team_id: String,
    command: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, AppError> {
    let client = state.current_client()?;

    let body = serde_json::json!({
        "channel_id": channel_id,
        "command": command,
        "team_id": team_id,
    });

    let resp = client.post("commands/execute", None, &body).await?;

    Ok(resp)
}

#[tauri::command]
pub async fn add_reaction(
    post_id: String,
    emoji_name: String,
    user_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), AppError> {
    let client = state.current_client()?;

    let body = Reaction {
        user_id,
        post_id,
        emoji_name,
    };
    let _resp: serde_json::Value = client.post("reactions", None, &body).await?;

    Ok(())
}

#[tauri::command]
pub async fn remove_reaction(
    post_id: String,
    emoji_name: String,
    user_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), AppError> {
    let client = state.current_client()?;

    let _resp: serde_json::Value = client
        .query(
            "DELETE",
            &format!("users/{user_id}/posts/{post_id}/reactions/{emoji_name}"),
            None,
            None,
        )
        .await?;

    Ok(())
}

#[tauri::command]
pub async fn get_posts(
    channel_id: String,
    before: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Post>, AppError> {
    let client = state.current_client()?;

    let mut params = vec![("per_page", "30")];
    if let Some(id) = &before {
        params.push(("before", id.as_str()));
    }

    let raw_list : serde_json::Value = client
    .query(
        "GET",
        &format!("channels/{channel_id}/posts"),
        Some(&params),
        None,
    )
    .await?;
    let list : PostList = serde_json::from_value(raw_list)?;

    // 'order' -> from new to old
    let posts = list
        .order
        .iter()
        .rev()
        .filter_map(|id| list.posts.get(id).cloned())
        .collect();
    

    if before.is_none() {
        let chat_path = state.cache_dir.join("chat").join(&channel_id);
        if let Ok(post_serialized) = serde_json::to_string(&posts){
            atomic_file_write(&chat_path, &post_serialized);
        }
    }
    Ok(posts)
}

#[tauri::command]
pub async fn get_users_by_ids(
    ids: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<MMUser>, AppError> {
    let client = state.current_client()?;

    let resp = client.post("users/ids", None, &ids).await?;

    Ok(resp)
}

#[tauri::command]
pub async fn search_users(
    term: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<MMUser>, AppError> {
    let client = state.current_client()?;

    let body = serde_json::json!({ "term": term });

    let resp = client.post("users/search", None, &body).await?;

    Ok(resp)
}

#[tauri::command]
pub async fn create_chat(
    user_ids: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Channel, AppError> {
    let client = state.current_client()?;

    // 2 id → direct message; 3+ → group message.
    let endpoint = if user_ids.len() <= 2 {
        "direct"
    } else {
        "group"
    };
    let resp = client
        .post(&format!("channels/{endpoint}"), None, &user_ids)
        .await?;
    Ok(resp)
}

#[tauri::command]
pub async fn create_named_channel(
    team_id: String,
    name: String,
    display_name: String,
    channel_type: String,
    state: tauri::State<'_, AppState>,
) -> Result<Channel, AppError> {
    let client = state.current_client()?;

    let body = serde_json::json!({
        "team_id": team_id,
        "name": name,
        "display_name": display_name,
        "type": channel_type,
    });
    let resp = client.post("channels", None, &body).await?;

    Ok(resp)
}

pub async fn channels_for_team(
    client: &Mattermost,
    team_id: &str,
) -> Result<Vec<Channel>, AppError> {
    let resp = client
        .query(
            "GET",
            &format!("users/me/teams/{team_id}/channels"),
            None,
            None,
        )
        .await?;
    Ok(resp)
}

pub async fn teams_for(client: &Mattermost) -> Result<Vec<Team>, AppError> {
    let resp = client.query("GET", "users/me/teams", None, None).await?;
    Ok(resp)
}

#[tauri::command]
pub async fn fetch_all_channels(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Channel>, AppError> {
    let client = state.current_client()?;

    let teams = teams_for(&client).await?;

    let mut all: Vec<Channel> = Vec::new();

    for team in &teams {
        let chans = channels_for_team(&client, &team.id).await?;
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

pub async fn members_for_team(
    client: &Mattermost,
    team_id: &str,
) -> Result<Vec<ChannelMember>, AppError> {
    let resp = client
        .query(
            "GET",
            &format!("users/me/teams/{team_id}/channels/members"),
            None,
            None,
        )
        .await?;
    Ok(resp)
}
