import tempfile
import sys
import os
import subprocess
import asyncio

async def run_tdd_pipeline(original_code: str, error_trace: str, fixed_code: str):
    """
    Executes the TDD validation loop:
    1. Writes code to a temp file.
    2. Runs it to verify it resolves the error.
    3. Returns execution results.
    """
    with tempfile.NamedTemporaryFile(delete=False, suffix=".py", mode='w', encoding='utf-8') as tmp:
        tmp.write(fixed_code)
        tmp_path = tmp.name

    try:
        def execute():
            return subprocess.run(
                [sys.executable, tmp_path],
                capture_output=True,
                text=True
            )
            
        result = await asyncio.to_thread(execute)
        output = result.stdout + result.stderr
        
        return {
            "success": result.returncode == 0,
            "output": output,
            "returncode": result.returncode
        }
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)