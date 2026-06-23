"""Web search backend settings."""

from pydantic import BaseModel


class SearchSettings(BaseModel):
    searxng_url: str = "http://localhost:18888"
    tavily_api_key: str = ""
    tavily_base_url: str = "https://api.tavily.com"
