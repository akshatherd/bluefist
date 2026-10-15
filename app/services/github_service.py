from urllib.parse import urlsplit
from github import Github
from app.core.config import settings

# Initialize GitHub client
def get_repo(repo_url: str):
    """
    Extract repo name from URL and return repo object
    """
    try:
        parsed = urlsplit(repo_url)
        if parsed.scheme != "https" or parsed.hostname != "github.com" or parsed.query or parsed.fragment:
            raise ValueError("Only https://github.com/{owner}/{repo} URLs are supported")
        parts = [part for part in parsed.path.split("/") if part]
        if len(parts) != 2:
            raise ValueError("Repository URL must contain exactly an owner and repository")
        repo_name = "/".join(parts)
        client = Github(settings.github_token or None, timeout=15)
        return client.get_repo(repo_name)
    except Exception as e:
        raise Exception(f"Failed to access repo: {str(e)}")
