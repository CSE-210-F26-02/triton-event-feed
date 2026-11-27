"""Guard: no one-letter names in the backend's own Python code.

Names must say what a value is (e.g. "index", not "i"). Python has no
built-in lint rule for this, so this test walks every backend module and
fails on any one-character variable, parameter, function, class, loop or
exception name, so CI blocks new ones. (The frontend uses ESLint's
id-length rule for the same purpose.)
"""

import ast
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]

# Folders that hold third-party or generated code, not ours.
SKIPPED_FOLDERS = {".venv", "venv", "__pycache__", ".ruff_cache"}

# Shortest allowed name.
MIN_NAME_LENGTH = 2

# Nodes that declare a name through their .name attribute.
DEFINITION_NODES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)


def backend_python_files():
    """Every .py file in backend/, except third-party folders."""
    return sorted(
        path
        for path in BACKEND_DIR.rglob("*.py")
        if not SKIPPED_FOLDERS & set(path.relative_to(BACKEND_DIR).parts)
    )


def declared_names(tree):
    """Yield (name, line) for every name the code declares."""
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
            yield node.id, node.lineno
        elif isinstance(node, ast.arg):
            yield node.arg, node.lineno
        elif isinstance(node, DEFINITION_NODES):
            yield node.name, node.lineno
        elif isinstance(node, ast.ExceptHandler) and node.name:
            yield node.name, node.lineno
        elif isinstance(node, ast.alias) and node.asname:
            yield node.asname, node.lineno


def short_names_in(path):
    """Return "file:line name" for each too-short name in one file."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    relative_path = path.relative_to(BACKEND_DIR)
    return [
        f"{relative_path}:{line} {name!r}"
        for name, line in declared_names(tree)
        if len(name) < MIN_NAME_LENGTH
    ]


def test_found_backend_files():
    """Guard against a wrong path silently checking nothing."""
    assert BACKEND_DIR.joinpath("main.py") in backend_python_files()


def test_no_one_letter_names():
    offenders = []
    for path in backend_python_files():
        offenders += short_names_in(path)
    assert offenders == [], "Use descriptive names:\n" + "\n".join(offenders)


def test_detects_one_letter_names(tmp_path):
    """The check itself must catch a short name."""
    sample = tmp_path / "sample.py"
    sample.write_text("def total(x):\n    return x\n", encoding="utf-8")
    tree = ast.parse(sample.read_text(encoding="utf-8"))
    assert ("x", 1) in list(declared_names(tree))
