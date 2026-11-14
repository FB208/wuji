"""应用配置。所有第三方密钥仅保存在后端环境变量中（文档 14.2）。"""
from functools import lru_cache

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.providers.semantic_contracts import (
    DEFAULT_SEMANTIC_BATCH_CONCURRENCY,
    DEFAULT_SEMANTIC_CALL_TIMEOUT_SECONDS,
    DEFAULT_SEMANTIC_MAX_BATCH_ITEMS,
    DEFAULT_SEMANTIC_MAX_BATCHES,
    DEFAULT_SEMANTIC_MAX_CALLS,
    DEFAULT_SEMANTIC_MAX_INPUT_CHARS,
    DEFAULT_SEMANTIC_MAX_OUTPUT_TOKENS,
    DEFAULT_SEMANTIC_MAX_RESPONSE_BYTES,
    DEFAULT_SEMANTIC_RECORD_EXCERPT_CHARS,
    DEFAULT_SEMANTIC_TOTAL_TIMEOUT_SECONDS,
)


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

    # 火山引擎大模型录音文件识别（2.0 标准版，submit + query 轮询）
    volc_speech_base_url: str = "https://openspeech.bytedance.com"
    # 火山方舟控制台「API Key 管理」创建的 Key（X-Api-Key 鉴权）
    volc_speech_api_key: str = ""
    volc_speech_resource_id: str = "volc.seedasr.auc"
    volc_speech_poll_interval_seconds: float = 0.5
    volc_speech_max_wait_seconds: float = 60.0

    # OpenAI-compatible 语义服务
    semantic_base_url: str = "https://provider.example.com/v1"
    semantic_api_key: str = ""
    semantic_model: str = ""
    semantic_max_input_chars: int = Field(default=DEFAULT_SEMANTIC_MAX_INPUT_CHARS, gt=0)
    semantic_max_batch_items: int = Field(default=DEFAULT_SEMANTIC_MAX_BATCH_ITEMS, gt=0)
    semantic_max_batches: int = Field(default=DEFAULT_SEMANTIC_MAX_BATCHES, gt=0)
    semantic_batch_concurrency: int = Field(default=DEFAULT_SEMANTIC_BATCH_CONCURRENCY, gt=0)
    semantic_max_calls: int = Field(default=DEFAULT_SEMANTIC_MAX_CALLS, gt=0)
    semantic_total_timeout_seconds: float = Field(default=DEFAULT_SEMANTIC_TOTAL_TIMEOUT_SECONDS, gt=0)
    semantic_call_timeout_seconds: float = Field(default=DEFAULT_SEMANTIC_CALL_TIMEOUT_SECONDS, gt=0)
    semantic_record_excerpt_chars: int = Field(default=DEFAULT_SEMANTIC_RECORD_EXCERPT_CHARS, ge=0)
    semantic_max_response_bytes: int = Field(default=DEFAULT_SEMANTIC_MAX_RESPONSE_BYTES, gt=0)
    semantic_max_output_tokens: int = Field(default=DEFAULT_SEMANTIC_MAX_OUTPUT_TOKENS, gt=0)

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

    @model_validator(mode="after")
    def _require_production_secrets(self) -> "Settings":
        if self.app_env != "production":
            return self
        missing: list[str] = []
        if not self.app_secret or self.app_secret == "change-me-app-secret":
            missing.append("APP_SECRET")
        if not self.jwt_secret or self.jwt_secret == "change-me-jwt-secret":
            missing.append("JWT_SECRET")
        if self.database_url == "mysql+asyncmy://user:password@localhost:3306/wuji?charset=utf8mb4":
            missing.append("DATABASE_URL")
        for name in (
            "wechat_app_id", "wechat_app_secret",
            "rustfs_access_key", "rustfs_secret_key",
            "volc_speech_api_key",
            "semantic_api_key", "semantic_model",
        ):
            if not getattr(self, name):
                missing.append(name.upper())
        if missing:
            raise ValueError("生产环境缺少必需配置：" + ", ".join(missing))
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
