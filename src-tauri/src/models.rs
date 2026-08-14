#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct Team {
    pub id: String,
    pub name: String,
    pub display_name: String,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, Clone)]
pub struct Channel {
    pub id: String,
    #[serde(rename = "type")]
    pub channel_type: String,
    pub display_name: String,
    pub name: String,
    pub team_id: String,
    pub last_post_at: i64,
    pub total_msg_count: i64,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, Clone)]
pub struct ChannelMember {
    pub channel_id: String,
    pub msg_count: i64,
    pub mention_count: i64,
    pub last_viewed_at: i64,
}

#[derive(serde::Serialize)]
pub struct ChannelWithMember {
    #[serde(flatten)]
    pub channel: Channel,
    pub member: Option<ChannelMember>,
}

#[derive(Debug, serde::Serialize)]
pub struct ChannelGroups {
    pub chat: Vec<Channel>,
    pub community: Vec<Channel>,
}

#[derive(serde::Deserialize, serde::Serialize, Clone)]
pub struct Post {
    pub id: String,
    pub message: String,
    pub user_id: String,
    pub create_at: i64,
    #[serde(default)]
    pub file_ids: Vec<String>,
    #[serde(default)]
    pub metadata: PostMetadata,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, Clone, Default)]
pub struct PostMetadata {
    #[serde(default)]
    pub reactions: Vec<Reaction>,
}

#[derive(serde::Deserialize, serde::Serialize, Clone)]
pub struct FileInfo {
    pub id: String,
    pub name: String,
    pub size: i64,
    pub mime_type: String,
}

#[derive(serde::Deserialize)]
pub struct PostList {
    pub order: Vec<String>,
    pub posts: std::collections::HashMap<String, Post>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, Clone)]
pub struct CustomEmoji {
    pub id: String,
    pub name: String,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, Clone)]
pub struct Reaction {
    pub user_id: String,
    pub post_id: String,
    pub emoji_name: String,
}

#[derive(serde::Deserialize, serde::Serialize)]
pub struct MMUser {
    pub id: String,
    pub username: String,
    pub first_name: String,
    pub last_name: String,
    pub nickname: String,
}
