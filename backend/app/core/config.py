"""应用配置。所有第三方密钥仅保存在后端环境变量中（文档 14.2）。"""
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_env: str = "development"
    app_secret: str = "change-me-app-secret"

    # 数据库
    database_url: str = "mysql+asyncmy://user:password@localhost:3306/wuji?charset=utf8mb4"

    # JWT
    jwt_secret: str = "change-me-jwt-secret"
    jwt_access_ttl_minutes: int = 120

    # 微信小程序
    wechat_app_id: str = "wxd5ef56552afdea8b"
    wechat_app_secret: str = ""

    # RustFS（S3 兼容）
    rustfs_endpoint: str = "http://localhost:9000"
    rustfs_access_key: str = ""
    rustfs_secret_key: str = ""
    rustfs_bucket: str = "wuji-items"
    rustfs_public_base_url: str = "http://localhost:9000/wuji-items"

    # 火山引擎大模型录音文件识别（极速版）
    volc_speech_endpoint: str = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash"
    volc_speech_app_id: str = ""
    volc_speech_access_token: str = ""
    volc_speech_resource_id: str = "volc.bigasr.auc_turbo"

    # OpenAI-compatible 语义服务
    semantic_base_url: str = "https://provider.example.com/v1"
    semantic_api_key: str = ""
    semantic_model: str = ""
    semantic_timeout_seconds: int = 30

    # 业务上限（文档 1.4 / 10.5）
    max_image_mb: int = 10
    max_audio_seconds: int = 60
    max_family_items: int = 500

    # 邀请令牌有效期（文档 7.3）
    invite_ttl_days: int = 7

    # 图片令牌有效期（分钟）
    image_token_ttl_minutes: int = 30

    # 软删除图片延迟清理天数（文档 6.4）
    deleted_image_retain_days: int = 7


@lru_cache
def get_settings() -> Settings:
    return Settings()
