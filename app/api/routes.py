from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import time

from app.services.github_service import get_repo, get_python_files
from app.services.gemini_service import generate_fix
from app.services.docker_service import test_code, detect_syntax_error
from app.services.twilio_service import send_whatsapp

router = APIRouter()


class RepoRequest(BaseModel):
    repo_url: str


@router.get("/")
def home():
    return {"message": "BLUEFIST running"}


@router.post("/auto-fix")
def auto_fix(req: RepoRequest):
    try:
        # ✅ Step 1: Get repo
        repo = get_repo(req.repo_url)

        # ✅ Step 2: Get Python files
        files = get_python_files(repo)

        if not files:
            raise HTTPException(404, "No Python files found")

        # ✅ Step 3: Pick first file
        file = files[0]
        code = file.decoded_content.decode()

        print(f"📂 Processing: {file.path}")

        # ✅ Step 4: Detect syntax error
        error = detect_syntax_error(code)

        if not error:
            return {
                "message": "No syntax errors found",
                "file": file.path
            }

        print(f"⚠️ Error detected: {error}")

        # ✅ Step 5: Generate fix
        fixed = generate_fix(code, error)

        if not fixed:
            raise HTTPException(500, "AI failed to generate fix")

        # ✅ Step 6: Validate fix
        success = test_code(fixed)

        if not success:
            raise HTTPException(500, "Fix failed validation")

        # ✅ Step 7: Create UNIQUE branch (fixes 409 issue)
        source = repo.get_branch("main")
        branch = f"bluefist-fix-{int(time.time())}"

        repo.create_git_ref(
            ref=f"refs/heads/{branch}",
            sha=source.commit.sha
        )

        # ✅ Step 8: Get latest file from that branch (fixes SHA mismatch)
        latest_file = repo.get_contents(file.path, ref=branch)

        # ✅ Step 9: Update file safely
        repo.update_file(
            path=latest_file.path,
            message="BLUEFIST auto-fix",
            content=fixed,
            sha=latest_file.sha,
            branch=branch
        )

        # ✅ Step 10: Create PR
        pr = repo.create_pull(
            title="BLUEFIST Auto Fix",
            body=f"""
Automated fix by BLUEFIST

📁 File: {file.path}
⚠️ Error: {error}
""",
            head=branch,
            base="main"
        )

        # ✅ Step 11: WhatsApp notification
        send_whatsapp(
            f"""✅ BLUEFIST Fix Deployed

📁 File: {file.path}
⚠️ Error: {error}

🔧 Fix applied successfully
🔗 PR: {pr.html_url}
"""
        )

        return {
            "message": "Fix applied successfully",
            "file": file.path,
            "error": error,
            "pr_url": pr.html_url
        }

    except Exception as e:
        raise HTTPException(500, str(e))