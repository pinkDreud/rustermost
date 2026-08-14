#[tauri::command]
pub async fn get_file_thumbnail(
    file_id: String,
    state: tauri::State<'_, crate::session::AppState>,
) -> Result<String, crate::error::AppError> {
    let session = state.current_session()?;

    let url = format!("{}/api/v4/files/{}/thumbnail", session.base_url, file_id);

    let client = reqwest::Client::new();
    let resp = client.get(url).bearer_auth(session.token).send().await?;

    let bytes = resp.bytes().await?;

    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:image/jpeg;base64,{}", b64))
}

#[tauri::command]
pub async fn get_file(
    file_id: String,
    mime: String,
    state: tauri::State<'_, crate::session::AppState>,
) -> Result<String, crate::error::AppError> {
    let session = state.current_session()?;

    let url = format!("{}/api/v4/files/{}", session.base_url, file_id);

    let client = reqwest::Client::new();
    let resp = client.get(url).bearer_auth(session.token).send().await?;

    let bytes = resp.bytes().await?;

    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}

#[tauri::command]
pub async fn get_avatar(
    user_id: String,
    state: tauri::State<'_, crate::session::AppState>,
) -> Result<String, crate::error::AppError> {
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
pub async fn get_custom_emojis(
    page: i64,
    state: tauri::State<'_, crate::session::AppState>,
) -> Result<Vec<crate::models::CustomEmoji>, crate::error::AppError> {
    let client = state.current_client()?;
    let page_str = page.to_string();
    let params = [
        ("page", page_str.as_str()),
        ("per_page", "200"),
        ("sort", "name"),
    ];
    let emojis = client.query("GET", "emoji", Some(&params), None).await?;
    Ok(emojis)
}

// this keeps the reqwest as Mattermost::client::query deser the obtained bytes
#[tauri::command]
pub async fn get_emoji_image(
    emoji_id: String,
    state: tauri::State<'_, crate::session::AppState>,
) -> Result<String, crate::error::AppError> {
    let session = state.current_session()?;

    let url = format!("{}/api/v4/emoji/{emoji_id}/image", session.base_url);
    let resp = reqwest::Client::new()
        .get(url)
        .bearer_auth(&session.token)
        .send()
        .await?;

    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/png")
        .to_string();

    let bytes = resp.bytes().await?;

    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}

#[tauri::command]
pub async fn upload_file(
    channel_id: String,
    filename: String,
    data_b64: String,
    state: tauri::State<'_, crate::session::AppState>,
) -> Result<String, crate::error::AppError> {
    use base64::Engine;

    #[derive(serde::Deserialize)]
    struct FileUploadResponse {
        file_infos: Vec<crate::models::FileInfo>,
    }

    let data = base64::engine::general_purpose::STANDARD
        .decode(&data_b64)
        .map_err(|e| crate::error::AppError::Network(e.to_string()))?;

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

    parsed
        .file_infos
        .first()
        .map(|f| f.id.clone())
        .ok_or(crate::error::AppError::Network(
            "upload returned no file info".into(),
        ))
}
