def detect_syntax_error(code: str):
    """
    Detect Python syntax errors without Docker
    """
    try:
        compile(code, "<string>", "exec")
        return None
    except Exception as e:
        return str(e)


def test_code(code: str):
    """
    Lightweight validation (fallback for Docker)
    """
    error = detect_syntax_error(code)

    if error:
        print("❌ Code still has error:", error)
        return False

    print("✅ Code passed validation")
    return True