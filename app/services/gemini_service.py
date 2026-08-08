import os
import time
import logging
from typing import List, Dict, Optional

from dotenv import load_dotenv
from google import genai
from google.genai import types
import ollama

load_dotenv()

logging.basicConfig(level=logging.INFO)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

# To test the outage, change this to: client = genai.Client(api_key="FAKE_KEY_123")
client = genai.Client(api_key=GEMINI_API_KEY)

MODEL_NAME = os.getenv("GEMINI_MODEL", "gemini-3.1-flash-lite")

def _clean_response(text: str) -> str:
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

def _build_prompt(
    broken_code: str,
    error_message: str,
    ast_context: Optional[str],
    file_path: Optional[str],
    previous_attempts: Optional[List[Dict]]
) -> str:
    prompt = f"""
EXECUTION ID:
{time.time()}

=========================
AI-TDD CONTEXT
=========================
You are BLUEFIST.
BLUEFIST is an Autonomous Site Reliability Engine.
Your task is NOT merely fixing syntax.
Your objective is to create a regression-safe production patch.

Requirements:
1. Preserve existing functionality.
2. Fix every runtime error.
3. Never remove business logic unless absolutely necessary.
4. Keep naming conventions.
5. Preserve imports whenever possible.
6. Return ONLY valid Python source code.
7. Do NOT explain anything.
8. Do NOT wrap code inside markdown.
9. The generated code MUST execute successfully.
10. Target validation: Exit Code = 0

--------------------------------
FILE
{file_path or "Unknown"}
--------------------------------
ERROR TRACE
{error_message}
--------------------------------
AST CONTEXT
{ast_context or "Not Available"}
--------------------------------
BROKEN SOURCE
{broken_code}
"""
    if previous_attempts:
        prompt += "\n\n=========================\n"
        prompt += "PREVIOUS FAILED PATCHES\n"
        prompt += "=========================\n"
        for index, attempt in enumerate(previous_attempts, start=1):
            prompt += f"\nAttempt {index}\nGenerated Patch\n{attempt.get('code','')}\nSandbox Error\n{attempt.get('error','')}\n"
        prompt += "\nAnalyze every previous failure.\nDo NOT regenerate the same solution.\nProduce a completely different, fully working implementation.\n"
    return prompt

_SYSTEM_PROMPT = """
You are BLUEFIST, acting as a Staff Software Engineer performing an
emergency production hotfix under an Autonomous Site Reliability Engine
workflow. You perform Test-Driven Development automatically.

Return ONLY raw Python source code. Never use markdown. Never explain.
Never apologize. The returned code must execute successfully and exit
with code 0.
"""

def _generate_local_fallback(user_prompt: str) -> str:
    """The local Circuit Breaker fallback using Ollama."""
    logging.warning("🛡️ [CIRCUIT BREAKER] Primary LLM offline. Rerouting to local Qwen2.5-Coder model...")
    try:
        response = ollama.chat(model='qwen2.5-coder', messages=[
            {
                'role': 'system',
                'content': _SYSTEM_PROMPT
            },
            {
                'role': 'user',
                'content': user_prompt
            }
        ])
        
        raw_code = response.get('message', {}).get('content', '')
        clean_code = _clean_response(raw_code)
        logging.info("✅ Local Fallback patch generated successfully.")
        return clean_code
    except Exception as e:
        logging.error(f"💀 [FATAL] Local fallback engine also failed: {e}")
        return ""

def generate_fix(
    broken_code: str,
    error_message: str,
    ast_context: Optional[str] = None,
    file_path: Optional[str] = None,
    previous_attempts: Optional[List[Dict]] = None,
) -> str:
    logging.info("🧠 [GEMINI] Starting autonomous AI-TDD patch synthesis...")
    
    user_prompt = _build_prompt(
        broken_code=broken_code,
        error_message=error_message,
        ast_context=ast_context,
        file_path=file_path,
        previous_attempts=previous_attempts,
    )

    try:
        response = client.models.generate_content(
            model=MODEL_NAME,
            contents=[
                _SYSTEM_PROMPT,
                user_prompt,
            ],
            config=types.GenerateContentConfig(
                temperature=0.25,
                top_p=0.95,
                max_output_tokens=8192,
            ),
        )

        if not response.text:
            logging.error("Gemini returned an empty response.")
            return _generate_local_fallback(user_prompt)

        clean_code = _clean_response(response.text)
        logging.info("✅ Gemini patch generated successfully.")
        return clean_code

    except Exception as e:
        logging.error(f"⚠️ [API OUTAGE] Gemini generation failed: {e}")
        # CIRCUIT BREAKER ENGAGES HERE
        return _generate_local_fallback(user_prompt)