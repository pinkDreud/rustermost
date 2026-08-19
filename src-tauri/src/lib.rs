mod error;
mod models;
mod session;
use session::*;

mod ws;
use ws::*;

mod media;
use media::*;

use std::sync::Mutex;
use tauri::Manager;

mod api;
use api::*;

fn sweep_cache(dir: &std::path::Path) {
    if let Ok(iterator) = std::fs::read_dir(dir) {
        for item in iterator.flatten() {
            if let Ok(last_modified) = item.metadata().and_then(|meta| meta.modified()) {
                if let Ok(time_from_last_modified) = last_modified.elapsed() {
                    if time_from_last_modified > std::time::Duration::from_secs(60 * 60 * 24 * 30) {
                        println!(
                            "Removing - {}, it's more than 30 days old",
                            &item.path().display()
                        );
                        let _ = std::fs::remove_file(item.path());
                    }
                }
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let cache_dir = app.path().app_cache_dir()?;
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            std::fs::create_dir_all(cache_dir.join("emoji"))?;
            std::fs::create_dir_all(cache_dir.join("avatar"))?;
            std::fs::create_dir_all(cache_dir.join("file"))?;
            std::fs::create_dir_all(cache_dir.join("chat"))?;
            println!("{}", cache_dir.display());
            sweep_cache(&cache_dir.join("emoji"));
            sweep_cache(&cache_dir.join("avatar"));
            sweep_cache(&cache_dir.join("file"));
            sweep_cache(&cache_dir.join("chat"));
            let state = AppState {
                session: Mutex::new(None),
                session_m: Mutex::new(None),
                channels: Mutex::new(Vec::new()),
                ws_task: Mutex::new(None),
                cache_dir,
                data_dir,
            };
            app.manage(state);
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_app_status,
            open_sso_window,
            capture_session,
            fetch_me,
            fetch_teams,
            fetch_channels,
            fetch_grouped_channels,
            fetch_all_channels,
            get_cached_channels,
            connect_websocket,
            send_message,
            get_posts,
            get_users_by_ids,
            get_avatar,
            search_users,
            create_chat,
            create_named_channel,
            fetch_channel_members,
            fetch_all_channels_with_members,
            view_channel,
            get_file_info,
            get_file_thumbnail,
            get_file,
            upload_file,
            get_emoji_image,
            get_custom_emojis,
            add_reaction,
            remove_reaction,
            execute_command,
            get_cached_posts,
            restore_session
        ])
        .build(tauri::generate_context!())
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
