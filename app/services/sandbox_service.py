import asyncio
import logging
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

logger = logging.getLogger("bluefist.sandbox")

SANDBOX_TIMEOUT = 30

# Hard ceiling on how much of stdout/stderr we stream back per stream.
# Complex tracebacks (deep recursion, chained exceptions, long data dumps
# in a repr) can otherwise flood the websocket. Output beyond this is
# preserved in full for the returned `error_output`, only the *streamed*
# log lines are capped.
MAX_STREAMED_LINES = 500


def _decode(stream_bytes: bytes) -> str:
    """
    Decode subprocess output defensively. Patched code can print raw
    bytes, non-UTF-8 data, or partial multi-byte sequences (e.g. on a
    timeout kill mid-write) — never let a decode error mask the real
    sandbox result.
    """

    if not stream_bytes:
        return ""

    try:
        return stream_bytes.decode("utf-8", errors="replace").strip()
    except Exception as exc:
        logger.warning(f"Failed to decode sandbox output: {exc}")
        return "<unable to decode sandbox output>"


async def run_isothermal_sandbox(code: str):
    """
    Executes generated code inside an isolated temporary sandbox.

    Yields:
        (
            log_message,
            is_done,
            is_success,
            error_output
        )

    Designed for BLUEFIST AI-TDD validation.
    """

    sandbox_dir = tempfile.mkdtemp(prefix="bluefist_")
    file_path = Path(sandbox_dir) / "patched_file.py"

    try:
        file_path.write_text(code, encoding="utf-8")
    except Exception as e:
        logger.error(f"Failed to write sandbox file: {e}")
        yield (
            f"❌ [SANDBOX ERROR] Could not write patch to disk: {e}\n",
            True,
            False,
            str(e),
        )
        shutil.rmtree(sandbox_dir, ignore_errors=True)
        return

    try:

        yield (
            "⚡ [SANDBOX] Initializing isolated execution environment...\n",
            False,
            False,
            "",
        )

        start_time = time.perf_counter()

        def execute():

            return subprocess.run(
                [sys.executable, str(file_path)],
                capture_output=True,
                cwd=sandbox_dir,
                timeout=SANDBOX_TIMEOUT,
            )

        try:
            result = await asyncio.to_thread(execute)
            stdout = _decode(result.stdout)
            stderr = _decode(result.stderr)
            returncode = result.returncode

        except subprocess.TimeoutExpired as timeout_exc:

            # Even on a timeout, the process may have already written a
            # partial traceback or partial output — surface it instead of
            # discarding it, so the Gemini critic has something real to
            # work from on the next attempt.
            partial_stdout = _decode(timeout_exc.stdout or b"")
            partial_stderr = _decode(timeout_exc.stderr or b"")

            if partial_stdout:
                yield ("\n📤 STDOUT (partial, before timeout)\n", False, False, "")
                for line in partial_stdout.splitlines()[:MAX_STREAMED_LINES]:
                    yield (line + "\n", False, False, "")

            if partial_stderr:
                yield ("\n📥 STDERR (partial, before timeout)\n", False, False, "")
                for line in partial_stderr.splitlines()[:MAX_STREAMED_LINES]:
                    yield (line + "\n", False, False, "")

            combined = partial_stderr or partial_stdout
            timeout_error = (
                f"Sandbox Timeout after {SANDBOX_TIMEOUT}s"
                + (f"\n\n{combined}" if combined else "")
            )

            yield (
                f"❌ [TIMEOUT] Execution exceeded {SANDBOX_TIMEOUT} seconds.\n",
                True,
                False,
                timeout_error,
            )

            return

        duration = time.perf_counter() - start_time

        if stdout:

            yield (
                "\n📤 STDOUT\n",
                False,
                False,
                "",
            )

            stdout_lines = stdout.splitlines()
            for line in stdout_lines[:MAX_STREAMED_LINES]:
                yield (line + "\n", False, False, "")
                await asyncio.sleep(0.03)

            if len(stdout_lines) > MAX_STREAMED_LINES:
                omitted = len(stdout_lines) - MAX_STREAMED_LINES
                yield (f"... [{omitted} more stdout lines truncated] ...\n", False, False, "")

        if stderr:

            yield (
                "\n📥 STDERR\n",
                False,
                False,
                "",
            )

            stderr_lines = stderr.splitlines()
            for line in stderr_lines[:MAX_STREAMED_LINES]:
                yield (line + "\n", False, False, "")
                await asyncio.sleep(0.03)

            if len(stderr_lines) > MAX_STREAMED_LINES:
                omitted = len(stderr_lines) - MAX_STREAMED_LINES
                yield (f"... [{omitted} more stderr lines truncated] ...\n", False, False, "")

        if returncode == 0:

            yield (
                f"\n✅ [VALIDATION PASSED] Exit Code 0 ({duration:.2f}s)\n",
                True,
                True,
                "",
            )

        else:

            # Always hand the *full* (untruncated) stderr/stdout back as
            # error_output, even though the streamed log above may be
            # capped — the Gemini critic needs the complete traceback,
            # including chained "during handling of the above exception"
            # sections, to diagnose the real root cause.
            combined_error = stderr if stderr else stdout

            yield (
                f"\n❌ [VALIDATION FAILED] Exit Code {returncode} ({duration:.2f}s)\n",
                True,
                False,
                combined_error,
            )

    except Exception as e:

        logger.exception(f"Unhandled sandbox error: {e}")

        yield (
            f"❌ [SANDBOX ERROR] {str(e)}\n",
            True,
            False,
            str(e),
        )

    finally:

        try:
            shutil.rmtree(sandbox_dir, ignore_errors=True)
        except Exception:
            pass