// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use tauri::Manager;
use std::sync::Mutex;
struct AppState {
    token: Mutex<Option<String>>,
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState { 
            token: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![get_app_status, open_sso_window, capture_token, get_stored_token])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
