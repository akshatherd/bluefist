"""Validate generated Python without executing it on the host."""

import asyncio
import ast
import logging
import shutil
import subprocess

from app.core.config import settings

logger = logging.getLogger("bluefist.validator")
VALIDATION_TIMEOUT = 30


async def validate_patch_syntax(code: str):
    """Run a non-executing syntax check; require Docker isolation in production.

    The generated source is parsed as an AST and never executed. This is a
    syntax gate only; it does not claim to prove application behavior.
    """
    docker = shutil.which("docker")
    if not docker:
        if settings.environment == "production":
            yield ("❌ [VALIDATION UNAVAILABLE] Production requires Docker; patch was not executed.\n", True, False, "Docker executable not found")
            return
        try:
            await asyncio.to_thread(ast.parse, code)
            yield ("⚠️ [LOCAL SYNTAX CHECK PASSED] Development-only AST parse; source was not executed. Docker isolation is unavailable.\n", True, True, "")
        except (SyntaxError, ValueError, RecursionError) as exc:
            detail = str(exc)
            yield (f"❌ [LOCAL SYNTAX CHECK FAILED] {detail}\n", True, False, detail)
        return

    args = [
        docker, "run", "--rm", "--network=none", "--read-only",
        "--memory=128m", "--cpus=0.5", "--pids-limit=32",
        "--cap-drop=ALL", "--security-opt=no-new-privileges",
        "--user=65534:65534", "--tmpfs=/tmp:rw,noexec,nosuid,size=16m",
        "--entrypoint=python", "python:3.12-alpine", "-I", "-c",
        "import ast,sys; ast.parse(sys.stdin.read())",
    ]
    yield ("🛡️ [VALIDATION] Checking syntax in a network-isolated container; source will not be executed.\n", False, False, "")

    def validate():
        return subprocess.run(args, input=code, capture_output=True, text=True, timeout=VALIDATION_TIMEOUT, check=False)

    try:
        result = await asyncio.wait_for(asyncio.to_thread(validate), timeout=VALIDATION_TIMEOUT + 2)
        if result.returncode == 0:
            yield ("✅ [ISOLATED SYNTAX CHECK PASSED] Python AST parsed successfully in Docker; source was not executed. Behavioral tests were not run.\n", True, True, "")
        elif settings.environment != "production":
            try:
                await asyncio.to_thread(ast.parse, code)
                yield ("⚠️ [LOCAL SYNTAX CHECK PASSED] Docker could not complete validation; development-only AST parse passed and source was not executed.\n", True, True, "")
            except (SyntaxError, ValueError, RecursionError) as exc:
                detail = str(exc)
                yield (f"❌ [LOCAL SYNTAX CHECK FAILED] {detail}\n", True, False, detail)
        else:
            error = (result.stderr or result.stdout or "Container validation failed")[-4000:]
            yield (f"❌ [SYNTAX CHECK FAILED] {error}\n", True, False, error)
    except (asyncio.TimeoutError, subprocess.TimeoutExpired):
        yield (f"❌ [VALIDATION TIMEOUT] Container exceeded {VALIDATION_TIMEOUT} seconds.\n", True, False, "Container validation timed out")
    except Exception as exc:
        logger.exception("Container validation failed")
        yield (f"❌ [VALIDATION ERROR] {exc}\n", True, False, str(exc))
