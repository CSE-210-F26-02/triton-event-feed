"""
Guard: every name in the backend's own Python code says what it holds.

Someone new to the project should be able to tell a value's purpose from
its name and the code around it (e.g. "event", not "ev"; "index", not "i").
Python has no built-in lint rule for this, so this test walks every backend
module and fails, so CI blocks the change, on any variable, parameter,
attribute, function, class, loop or exception name that is

  * shorter than MIN_NAME_LENGTH characters (except ALLOWED_SHORT_NAMES), or
  * built from a cryptic abbreviation (ABBREVIATIONS), in any part of a
    snake_case or CamelCase name: "rec_json" and "fmtTime" are refused.

Short words that are real domain vocabulary (uri, url, did, sql, tag, ...)
are allowed: the surrounding code makes them clear. (The frontend uses
ESLint's id-length rule for the same purpose.)
"""

import ast
import re
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]

# Folders that hold third-party or generated code, not ours.
SKIPPED_FOLDERS = {".venv", "venv", "__pycache__", ".ruff_cache"}

# Shortest allowed name (underscores do not count).
MIN_NAME_LENGTH = 3

# Shorter names that are still clear: "id" is the notification id the API
# returns as JSON.
ALLOWED_SHORT_NAMES = {"id"}

# Abbreviations whose meaning a newcomer cannot guess; spell them out.
ABBREVIATIONS = {
    "addr", "arr", "btn", "cb", "cfg", "cm", "cnt", "coll", "conn", "ctx",
    "cur", "desc", "dt", "dur", "el", "ev", "evt", "fmt", "fn", "gen", "idx",
    "kw", "kwd", "li", "loc", "msg", "norm", "num", "obj", "op", "pos",
    "prev", "proc", "punct", "rec", "req", "res", "resp", "sep", "sub",
    "subs", "tmp", "tx", "upd", "val",
}  # fmt: skip

# Names a library chooses, which our code must use as-is: pytest passes its
# built-in fixtures by parameter name (tmp_path is a temporary folder).
LIBRARY_DEFINED_NAMES = {"tmp_path"}

# Nodes that declare a name through their .name attribute.
DEFINITION_NODES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)

# Splits snake_case and CamelCase names into their words.
NAME_PARTS = re.compile(r"_+|(?<=[a-z0-9])(?=[A-Z])")


def backend_python_files():
    """
    Every .py file in backend/, except third-party folders.

    :returns: the files' paths, sorted.
    """
    return sorted(
        path
        for path in BACKEND_DIR.rglob("*.py")
        if not SKIPPED_FOLDERS & set(path.relative_to(BACKEND_DIR).parts)
    )


def declared_names(tree):
    """
    Yield (name, line) for every name the code declares.

    :param tree: a parsed module.
    :yields: each declared name and the line it is on.
    """
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
            yield node.id, node.lineno
        elif isinstance(node, ast.Attribute) and isinstance(
            node.ctx, ast.Store
        ):
            yield node.attr, node.lineno
        elif isinstance(node, ast.arg):
            yield node.arg, node.lineno
        elif isinstance(node, DEFINITION_NODES):
            yield node.name, node.lineno
        elif isinstance(node, ast.ExceptHandler) and node.name:
            yield node.name, node.lineno
        elif isinstance(node, ast.alias) and node.asname:
            yield node.asname, node.lineno


def is_dunder(name):
    """
    Check for Python's own special names such as __init__ and __all__.

    :param name: an identifier.
    :returns: True for a double-underscore name.
    """
    return name.startswith("__") and name.endswith("__")


def naming_problem(name):
    """
    Explain why a name is unclear, or return None when it is fine.

    :param name: a declared identifier.
    :returns: A short reason, or None.
    """
    if is_dunder(name) or name in LIBRARY_DEFINED_NAMES:
        return None
    bare = name.strip("_")
    if len(bare) < MIN_NAME_LENGTH and bare.lower() not in ALLOWED_SHORT_NAMES:
        return f"shorter than {MIN_NAME_LENGTH} characters"
    for part in NAME_PARTS.split(bare):
        if part.lower() in ABBREVIATIONS:
            return f'"{part}" is an abbreviation'
    return None


def unclear_names_in(path):
    """
    Find every unclear name in one file.

    :param path: the .py file to check.
    :returns: "file:line name (reason)" for each unclear name.
    """
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    relative_path = path.relative_to(BACKEND_DIR)
    return [
        f"{relative_path}:{line} {name!r} ({problem})"
        for name, line in declared_names(tree)
        if (problem := naming_problem(name))
    ]


def test_found_backend_files():
    """
    Guard against a wrong path silently checking nothing.
    """
    assert BACKEND_DIR.joinpath("main.py") in backend_python_files()


def test_every_name_is_descriptive():
    offenders = []
    for path in backend_python_files():
        offenders += unclear_names_in(path)
    assert offenders == [], "Use descriptive names:\n" + "\n".join(offenders)


def test_detects_one_letter_names(tmp_path):
    """
    The check itself must catch a short name.
    """
    sample = tmp_path / "sample.py"
    sample.write_text("def total(x):\n    return x\n", encoding="utf-8")
    tree = ast.parse(sample.read_text(encoding="utf-8"))
    assert ("x", 1) in list(declared_names(tree))
    assert naming_problem("x") == "shorter than 3 characters"


def test_detects_two_letter_names():
    assert naming_problem("ev") == "shorter than 3 characters"
    assert naming_problem("_") == "shorter than 3 characters"


def test_detects_abbreviations_in_any_part_of_a_name():
    assert naming_problem("msg") == '"msg" is an abbreviation'
    assert naming_problem("rec_json") == '"rec" is an abbreviation'
    assert naming_problem("_fmt_time") == '"fmt" is an abbreviation'
    assert naming_problem("FmtTime") == '"Fmt" is an abbreviation'
    assert naming_problem("EV_URI") == '"EV" is an abbreviation'


def test_detects_attribute_names():
    tree = ast.parse("self.cb = handler\n")
    assert ("cb", 1) in list(declared_names(tree))


def test_allows_descriptive_and_domain_names():
    for name in (
        "event",
        "record_json",
        "subscriber_id",
        "uri",
        "did",
        "id",
        "__init__",
        "_format_time",
        "SubscriptionNotifier",
        "tmp_path",
    ):
        assert naming_problem(name) is None, name
