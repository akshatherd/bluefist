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