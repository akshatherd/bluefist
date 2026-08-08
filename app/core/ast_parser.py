import ast

def extract_function_from_file(filepath: str, target_line: int) -> str:
    """
    Reads a Python file and extracts ONLY the function containing the error line.
    Saves thousands of tokens by ignoring the rest of the repository.
    """
    try:
        with open(filepath, "r", encoding="utf-8") as file:
            file_content = file.read()
            
        # Parse the entire file into an Abstract Syntax Tree
        tree = ast.parse(file_content)
        
        # Search the tree for the function that contains our crashed line
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                # Check if the target line falls inside this function/class
                if hasattr(node, "lineno") and hasattr(node, "end_lineno"):
                    if node.lineno <= target_line <= node.end_lineno:
                        # Extract just this specific block of code
                        lines = file_content.splitlines()
                        return "\n".join(lines[node.lineno - 1 : node.end_lineno])
                        
        return "Function context not found."
    except Exception as e:
        return f"AST Extraction Error: {str(e)}"