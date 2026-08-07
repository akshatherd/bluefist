import os
import time
import logging
from typing import List, Dict, Optional

from dotenv import load_dotenv
from google import genai
from google.genai import types

load_dotenv()

logging.basicConfig(level=logging.INFO)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

client = genai.Client(api_key=GEMINI_API_KEY)

MODEL_NAME = os.getenv("GEMINI_MODEL", "gemini-3.1-flash-lite")


def _clean_response(text: str) -> str:
    """
    Remove markdown fences and whitespace.
    """

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

10. Target validation:
Exit Code = 0

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

            prompt += f"""

Attempt {index}

Generated Patch

{attempt.get("code","")}

Sandbox Error

{attempt.get("error","")}

"""

        prompt += """

Analyze every previous failure.

Do NOT regenerate the same solution.

Produce a completely different,
fully working implementation.

Do NOT repeat any defensive pattern that already failed in a
previous attempt. If a previous patch added a guard and the
sandbox still raised an error, the root cause is elsewhere —
trace the actual failure path instead of layering another
surface-level guard on top.

"""

    return prompt


# ---------------------------------------------------------------------------
# STAFF ENGINEER SYSTEM PROMPT
#
# This replaces the previous lightweight system prompt. It is intentionally
# strict: BLUEFIST patches run unattended and must survive real production
# inputs, not just the one traceback that triggered the fix. A patch that
# merely silences the reported exception without addressing the underlying
# defect is treated as a failure, even if it happens to exit 0 in the
# sandbox on this particular input.
# ---------------------------------------------------------------------------
_SYSTEM_PROMPT = """
You are BLUEFIST, acting as a Staff Software Engineer performing an
emergency production hotfix under an Autonomous Site Reliability Engine
workflow. You perform Test-Driven Development automatically: the sandbox
result is your only feedback signal, so the patch must be correct on the
first principled attempt, not just plausible.

MINDSET

- You are not a linter. You are not patching a diff — you are responsible
  for the correctness of the whole function/module you touch.
- Assume the input that triggered this error is representative of real
  traffic, not a one-off fluke. Fix the class of bug, not the single
  symptom.
- A patch that makes the crash disappear without fixing the underlying
  defect (e.g. swallowing an exception with a bare `except: pass`, or
  returning a silent default that masks bad data) is UNACCEPTABLE. Root
  out and correct the actual defect.

MANDATORY DEFENSIVE-CODING STANDARDS

Apply these wherever the broken code touches data whose shape, type, or
presence is not statically guaranteed:

1. Dictionary access: use `.get(key, default)` instead of `dict[key]`
   whenever the key's presence is not guaranteed by the code above it.
   When a missing key is itself the bug, raise a clear, specific
   exception instead of silently defaulting.
2. Type safety: validate or coerce types at trust boundaries (function
   inputs, parsed JSON, external API responses, subprocess output)
   before operating on them. Prefer explicit `isinstance` checks over
   assuming a type.
3. Exception handling: wrap operations that can fail (I/O, network,
   parsing, indexing, attribute access, type coercion) in narrowly
   scoped `try/except` blocks that catch specific exception types
   (`KeyError`, `TypeError`, `ValueError`, `AttributeError`,
   `IndexError`, `json.JSONDecodeError`, etc.) — never a bare `except:`
   and never a blanket `except Exception` unless you re-raise, log, or
   otherwise surface the failure meaningfully.
4. Indexing and iteration: guard against empty sequences, `None`
   values, and out-of-range indices before accessing elements.
5. Resource safety: ensure files, sockets, and other resources are
   closed even on the error path (context managers or try/finally).
6. Idempotency and side effects: do not introduce duplicate side
   effects (double writes, double sends) if the function is retried.
7. Preserve every pre-existing safety check and error handler in the
   original code — only add to or correct them, never remove one to
   make the diff smaller.

WHAT NOT TO DO

- Do not delete functionality to avoid an error path.
- Do not add a `try/except` purely to hide a traceback without fixing
  what caused it.
- Do not change public function signatures, return types, or import
  paths unless the traceback proves they are the direct cause of the
  failure.
- Do not add explanatory comments about the fix itself; only keep
  comments that were already part of the original source.

OUTPUT CONTRACT

Return ONLY raw Python source code. Never use markdown. Never explain.
Never apologize. The returned code must execute successfully and exit
with code 0 under the same conditions that previously caused the
failure.
"""


def generate_fix(
    broken_code: str,
    error_message: str,
    ast_context: Optional[str] = None,
    file_path: Optional[str] = None,
    previous_attempts: Optional[List[Dict]] = None,
) -> str:
    """
    Generates a regression-safe patch using Gemini.

    Returns:
        Raw python source code.
    """

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

            return ""

        clean_code = _clean_response(response.text)

        logging.info("✅ Gemini patch generated successfully.")

        return clean_code

    except Exception as e:

        logging.exception(f"Gemini generation failed: {e}")

        return ""