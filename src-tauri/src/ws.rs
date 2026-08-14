use async_trait::async_trait;
use mattermost_api::socket::{WebsocketEvent, WebsocketEventType, WebsocketHandler};
use tauri::Emitter;

#[derive(serde::Serialize, Clone)]
struct IncomingMessage {
    id: String,
    file_ids: Vec<String>,
    channel_id: String,
    sender: String,
    message: String,
}

#[derive()]
struct WsHandler {
    app: tauri::AppHandle,
}

#[async_trait]
impl WebsocketHandler for WsHandler {
    async fn callback(&self, message: WebsocketEvent) {
        match message.event {
            WebsocketEventType::Posted => {
                if let Some(post_str) = message.data["post"].as_str() {
                    if let Ok(post) = serde_json::from_str::<serde_json::Value>(post_str) {
                        let msg = IncomingMessage {
                            channel_id: post["channel_id"].as_str().unwrap_or("").to_string(),
                            sender: message.data["sender_name"]
                                .as_str()
                                .unwrap_or("")
                                .to_string(),
                            message: post["message"].as_str().unwrap_or("").to_string(),
                            id: post["id"].as_str().unwrap_or("").to_string(),
                            file_ids: post["file_ids"]
                                .as_array()
                                .map(|a| {
                                    a.iter()
                                        .filter_map(|v| v.as_str().map(String::from))
                                        .collect()
                                })
                                .unwrap_or_default(),
                        };
                        let _ = self.app.emit("mm-post", msg);
                    }
                }
            }
            e @ (WebsocketEventType::ReactionAdded | WebsocketEventType::ReactionRemoved) => {
                if let Some(r_str) = message.data["reaction"].as_str() {
                    if let Ok(r) = serde_json::from_str::<serde_json::Value>(r_str) {
                        let payload = crate::models::Reaction {
                            user_id: r["user_id"].as_str().unwrap_or("").to_string(),
                            post_id: r["post_id"].as_str().unwrap_or("").to_string(),
                            emoji_name: r["emoji_name"].as_str().unwrap_or("").to_string(),
                        };
                        let name = if matches!(e, WebsocketEventType::ReactionAdded) {
                            "mm-reaction-added"
                        } else {
                            "mm-reaction-removed"
                        };
                        let _ = self.app.emit(name, payload);
                    }
                }
            }
            _ => {}
        }
    }
}

#[tauri::command]
pub async fn connect_websocket(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::session::AppState>,
) -> Result<(), crate::error::AppError> {
    {
        let mut guard = state.ws_task.lock().unwrap();
        if let Some(h) = guard.take() {
            h.abort();
        }
    }
    let mut client = state.current_client()?;

    let join_handle = tokio::spawn(async move {
        loop {
            let handler = WsHandler { app: app.clone() };
            if let Err(e) = client.connect_to_websocket(handler).await {
                eprintln!("WS error: {}", e);
            }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
    });
    {
        let mut guard = state.ws_task.lock().unwrap();
        *guard = Some(join_handle);
    }
    Ok(())
}
