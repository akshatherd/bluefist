import httpx
from app.core.config import settings


def generate_fix(code: str, error: str):
    """
    Generate fix using Gemini based on actual error
    """

    prompt = f"""
You are a senior Python Site Reliability Engineer.

Your job is to fix the given code based on the error.

STRICT RULES:
- Return ONLY fixed code
- Do NOT add explanations
- Do NOT add markdown
- Ensure code runs without errors

ERROR:
{error}

CODE:
{code}
"""

    response = httpx.post(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        params={"key": settings.GEMINI_API_KEY},
        json={
            "contents": [{"parts": [{"text": prompt}]}]
        },
        timeout=30
    )

    data = response.json()

    try:
        return data["candidates"][0]["content"]["parts"][0]["text"]
    except Exception:
        print("Gemini response error:", data)
        return None