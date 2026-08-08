import os
import logging
from google import genai
from google.genai import types

# Use the same resilient client setup
client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
MODEL_NAME = os.getenv("GEMINI_MODEL", "gemini-3.1-flash-lite")

def _clean_test_code(text: str) -> str:
    if not text:
        return ""
    code = text.strip()
    if code.startswith("```python"):
        code = code[len("```python"):]
    elif code.startswith("```"):
        code = code[3:]
    if code.endswith("```"):
        code = code[:-3]
    return code.strip()

def generate_regression_test(original_error: str, patched_code: str, file_path: str) -> str:
    """
    Synthesizes a PyTest script to prevent this specific traceback from ever happening again.
    """
    logging.info("🧪 [TEST ENGINE] Synthesizing Zero-Day Regression Test...")

    prompt = f"""
You are BLUEFIST, an autonomous QA Automation Engineer.
A production crash just occurred with this traceback:
{original_error}

I have applied the following patched code to the file `{file_path}`:
{patched_code}

Write a comprehensive `pytest` test case that:
1. Recreates the conditions of the original crash.
2. Asserts that the patched code handles it gracefully (e.g., returns expected output or raises a controlled, specific exception instead of crashing).
3. Uses `pytest.fixture` if mocking is necessary.

Return ONLY raw Python code. Do not use markdown blocks. Do not explain.
"""

    try:
        response = client.models.generate_content(
            model=MODEL_NAME,
            contents=[prompt],
            config=types.GenerateContentConfig(
                temperature=0.1,  # Highly deterministic for tests
                top_p=0.95,
                max_output_tokens=2048,
            ),
        )
        test_code = _clean_test_code(response.text)
        logging.info("✅ Regression Test synthesized successfully.")
        return test_code
    except Exception as e:
        logging.error(f"⚠️ [TEST ENGINE] Failed to synthesize test: {e}")
        return ""