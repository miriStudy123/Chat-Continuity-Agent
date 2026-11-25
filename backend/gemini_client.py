import os
from pathlib import Path

from dotenv import load_dotenv
from google import genai
from google.genai import types


GEMINI_MODEL = "gemini-3.8-flash"

# Without these options the SDK waits forever and never retries.
# Timeout is per HTTP attempt, in milliseconds.
GEMINI_TIMEOUT_MS = 90_000
# Total attempts including the first call; retried only for temporary errors.
# 429 (quota) is not retried: an exhausted quota does not recover in seconds.
GEMINI_RETRY_ATTEMPTS = 3
GEMINI_RETRY_STATUS_CODES = [408, 500, 502, 503, 504]


def create_gemini_client() -> genai.Client:
    env_path = Path(__file__).with_name(".env")
    load_dotenv(dotenv_path=env_path)

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set in backend/.env")

    return genai.Client(
        api_key=api_key,
        http_options=types.HttpOptions(
            timeout=GEMINI_TIMEOUT_MS,
            retry_options=types.HttpRetryOptions(
                attempts=GEMINI_RETRY_ATTEMPTS,
                initial_delay=2.0,
                max_delay=20.0,
                http_status_codes=GEMINI_RETRY_STATUS_CODES,
            ),
        ),
    )
