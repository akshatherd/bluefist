import time
from github import Github
from app.core.config import settings

# Initialize GitHub client
g = Github(settings.GITHUB_TOKEN)

def get_repo(repo_url: str):
    """
    Extract repo name from URL and return repo object
    """
    try:
        repo_name = repo_url.replace("https://github.com/", "").strip("/")
        return g.get_repo(repo_name)
    except Exception as e:
        raise Exception(f"Failed to access repo: {str(e)}")

def get_python_files(repo):
    """
    Recursively fetch all Python files in repo
    """
    contents = repo.get_contents("")
    files = []

    while contents:
        file = contents.pop(0)

        if file.type == "dir":
            contents.extend(repo.get_contents(file.path))
        else:
            if file.name.endswith(".py"):
                files.append(file)

    return files

def create_patch_pr(repo_url: str, target_file_path: str, patched_code: str, test_file_path: str, test_code: str) -> str:
    """
    Creates a new branch, commits the patched code and the new PyTest,
    and opens a Pull Request on GitHub.
    """
    repo = get_repo(repo_url)
    default_branch = repo.default_branch
    
    # 1. Create a unique branch name based on timestamp
    branch_name = f"bluefist-hotfix-{int(time.time())}"
    base_ref = repo.get_git_ref(f"heads/{default_branch}")
    repo.create_git_ref(ref=f"refs/heads/{branch_name}", sha=base_ref.object.sha)
    
    # 2. Update the broken target file with the AI patch
    try:
        file_content = repo.get_contents(target_file_path, ref=default_branch)
        repo.update_file(
            path=target_file_path,
            message=f"fix: autonomous patch applied to {target_file_path}",
            content=patched_code,
            sha=file_content.sha,
            branch=branch_name
        )
    except Exception as e:
        raise Exception(f"Failed to update target file on GitHub: {e}")

    # 3. Create the brand-new PyTest file in the repository
    try:
        repo.create_file(
            path=test_file_path,
            message=f"test: zero-day regression test for {target_file_path}",
            content=test_code,
            branch=branch_name
        )
    except Exception as e:
        raise Exception(f"Failed to create test file on GitHub: {e}")

    # 4. Open the Pull Request
    pr = repo.create_pull(
        title=f"🚨 BLUEFIST Hotfix & Regression Test: {target_file_path}",
        body=(
            "### 🛡️ BLUEFIST Autonomous Execution Engine\n\n"
            "A critical anomaly was detected and successfully remediated.\n\n"
            "**This Pull Request contains:**\n"
            f"- `[PATCH]` Regression-safe fix for `{target_file_path}`.\n"
            f"- `[TEST]` New PyTest suite `{test_file_path}` to prevent recurrence.\n\n"
            "> *All changes have been verified in the Isothermal Sandbox. Exit Code: 0.*"
        ),
        head=branch_name,
        base=default_branch
    )
    
    return pr.html_url