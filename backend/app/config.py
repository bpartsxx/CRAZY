from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # LLM providers — Llama models split across three providers so each task
    # gets its own rate-limit bucket. Set the keys you have in .env; tasks fall
    # back to Groq if a provider key is missing.
    groq_api_key: str = ""
    cerebras_api_key: str = ""
    sambanova_api_key: str = ""
    # Kept for backwards compatibility / fallback. Not currently used.
    google_api_key: str = ""

    slack_token: str = ""
    slack_client_id: str = ""
    slack_client_secret: str = ""
    slack_redirect_uri: str = "http://localhost:8000/auth/slack/callback"

    database_url: str = "sqlite:///./inbox.db"
    frontend_origin: str = "http://localhost:5173"
    slack_poll_interval_seconds: int = 8

    # Each task has a chain of providers tried in order on rate-limit (429).
    # Default chains keep Groq as a LAST-RESORT fallback because its free tier
    # TPD (tokens-per-day) is the lowest of the three.
    #
    # Provider model ids per size class. Override any in .env.
    # Groq:
    groq_70b_model: str = "llama-3.3-70b-versatile"
    groq_8b_model: str = "llama-3.1-8b-instant"
    # Cerebras (verify your account's list with:
    # curl https://api.cerebras.ai/v1/models -H "Authorization: Bearer $CEREBRAS_API_KEY")
    # gpt-oss-120b is OpenAI's open-weights model — purpose-built for function
    # calling, so it handles the ReAct agent loop reliably without recursion.
    cerebras_70b_model: str = "gpt-oss-120b"
    cerebras_8b_model: str = "llama3.1-8b"
    # SambaNova (same: curl https://api.sambanova.ai/v1/models)
    # Avoid Meta-Llama-3.3-70B for the agent — it loops on tool calls and trips
    # the LangGraph recursion limit. gpt-oss-120b is much better at it.
    sambanova_70b_model: str = "gpt-oss-120b"
    sambanova_8b_model: str = "gemma-3-12b-it"

    # Legacy aliases (still read by some code paths). Keep in sync above.
    assistant_model: str = "llama-3.3-70b-versatile"
    summary_model: str = "llama-3.1-8b-instant"
    draft_model: str = "llama-3.3-70b-versatile"
    cerebras_draft_model: str = "llama-3.3-70b"
    sambanova_summary_model: str = "Meta-Llama-3.1-8B-Instruct"


settings = Settings()
