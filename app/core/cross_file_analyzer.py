import ast
import os
import re
from typing import Dict, List

def parse_traceback_files(error_trace: str) -> List[Dict[str, int]]:
    """
    Parses a Python stack trace to extract file paths and line numbers
    involved in the crash across the repository.
    """
    # Matches typical Python traceback lines: File "path/to/file.py", line 42, in func_name
    pattern = r'File "([^"]+\.py)", line (\d+)'
    matches = re.findall(pattern, error_trace)
    
    extracted_targets = []
    for filepath, lineno in matches:
        extracted_targets.append({
            "filepath": os.path.basename(filepath),
            "full_path": filepath,
            "lineno": int(lineno)
        })
    return extracted_targets

def extract_cross_file_contexts(error_trace: str, base_dir: str = ".") -> str:
    """
    Crawls the stack trace, extracts exact function contexts across multiple files,
    and returns a compressed, high-density context string for the LLM.
    """
    targets = parse_traceback_files(error_trace)
    if not targets:
        return "No multi-file trace data found."

    combined_context = "=== CROSS-FILE CALL GRAPH CONTEXT ===\n"
    
    for target in targets:
        filepath = target["full_path"]
        target_line = target["lineno"]
        
        # Fallback search in base_dir if absolute path doesn't match locally
        if not os.path.exists(filepath):
            local_candidate = os.path.join(base_dir, target["filepath"])
            if os.path.exists(local_candidate):
                filepath = local_candidate
            else:
                continue

        try:
            with open(filepath, "r", encoding="utf-8") as f:
                content = f.read()
                
            tree = ast.parse(content)
            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    if hasattr(node, "lineno") and hasattr(node, "end_lineno"):
                        if node.lineno <= target_line <= node.end_lineno:
                            lines = content.splitlines()
                            snippet = "\n".join(lines[node.lineno - 1 : node.end_lineno])
                            combined_context += f"\n--- FILE: {target['filepath']} (Lines {node.lineno}-{node.end_lineno}) ---\n{snippet}\n"
        except Exception as e:
            combined_context += f"\n--- ERROR PARSING {target['filepath']}: {str(e)} ---\n"
            
    return combined_context