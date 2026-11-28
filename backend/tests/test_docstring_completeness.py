"""
Guard: every backend module, class and function has a complete docstring.

CLAUDE.md asks every function and class to describe its purpose, parameters
and return value, so a newcomer never has to read the body to use it. This
test fails, so CI blocks the change, when

  * a module, class or function has no docstring at all;
  * a function parameter (other than self / cls) has no ":param name:";
  * a function that returns a value has no ":returns:"; or
  * a generator has no ":yields:".

Test functions (test_*) are exempt: pytest calls them, their names say what
they check, and their parameters are fixtures documented in conftest.py.
"""

import ast

from tests.test_docstring_style import (
    PARAM_FIELD,
    docstring_nodes,
    parameter_names,
)
from tests.test_naming import BACKEND_DIR, backend_python_files

# pytest runs these; their names describe them.
TEST_FUNCTION_PREFIX = "test_"

# The instance or class a method is bound to; never documented.
BOUND_PARAMETERS = {"self", "cls"}

RETURNS_FIELD = ":returns:"
YIELDS_FIELD = ":yields:"

FUNCTION_NODES = (ast.FunctionDef, ast.AsyncFunctionDef)

# Scopes whose statements belong to themselves, not to the enclosing function.
NESTED_SCOPES = (
    ast.FunctionDef,
    ast.AsyncFunctionDef,
    ast.ClassDef,
    ast.Lambda,
)


def own_nodes(function):
    """
    Yield every node in a function's body, skipping nested functions and
    classes (a nested function's return or yield is not this one's).

    :param function: a parsed function definition.
    :yields: each node that belongs to the function itself.
    """
    pending = [
        node for node in function.body if not isinstance(node, NESTED_SCOPES)
    ]
    while pending:
        node = pending.pop()
        yield node
        pending += [
            child
            for child in ast.iter_child_nodes(node)
            if not isinstance(child, NESTED_SCOPES)
        ]


def is_generator(function):
    """
    Check whether a function yields.

    :param function: a parsed function definition.
    :returns: True when its own body contains yield or yield from.
    """
    return any(
        isinstance(node, (ast.Yield, ast.YieldFrom))
        for node in own_nodes(function)
    )


def is_none(node):
    """
    Check whether an expression is the literal None.

    :param node: a parsed expression, or None when there is none.
    :returns: True for a missing expression or a literal None.
    """
    return node is None or (
        isinstance(node, ast.Constant) and node.value is None
    )


def is_stub(function):
    """
    Check whether a function has no body of its own (a Protocol method).

    :param function: a parsed function definition.
    :returns: True when its body holds only a docstring, ``...`` or pass.
    """
    return all(
        isinstance(statement, ast.Pass)
        or (
            isinstance(statement, ast.Expr)
            and isinstance(statement.value, ast.Constant)
        )
        for statement in function.body
    )


def returns_a_value(function):
    """
    Check whether a function gives its caller a value.

    :param function: a parsed function definition.
    :returns: True when it has a ``return <value>``, or when it is a stub
        whose return annotation is not None.
    """
    if any(
        isinstance(node, ast.Return) and not is_none(node.value)
        for node in own_nodes(function)
    ):
        return True
    return is_stub(function) and not is_none(function.returns)


def missing_fields(function):
    """
    List what a function's docstring leaves undocumented.

    :param function: a parsed function definition.
    :returns: one message per missing docstring or field (empty when it
        is complete).
    """
    docstring = ast.get_docstring(function)
    if docstring is None:
        return ["has no docstring"]
    documented = set(PARAM_FIELD.findall(docstring))
    problems = [
        f'has no ":param {name}:"'
        for name in sorted(parameter_names(function) - BOUND_PARAMETERS)
        if name not in documented
    ]
    if is_generator(function):
        if YIELDS_FIELD not in docstring:
            problems.append(f'yields but has no "{YIELDS_FIELD}"')
    elif returns_a_value(function) and RETURNS_FIELD not in docstring:
        problems.append(f'returns a value but has no "{RETURNS_FIELD}"')
    return problems


def incomplete_docstrings_in(source):
    """
    Find every missing docstring and field in one module.

    :param source: the module's source code.
    :returns: (line number, "name: problem") for each problem found.
    """
    tree = ast.parse(source)
    problems = [] if ast.get_docstring(tree) else [(1, "module: no docstring")]
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and ast.get_docstring(node) is None:
            problems.append((node.lineno, f"class {node.name}: no docstring"))
        if isinstance(node, FUNCTION_NODES) and not node.name.startswith(
            TEST_FUNCTION_PREFIX
        ):
            problems += [
                (node.lineno, f"{node.name}() {problem}")
                for problem in missing_fields(node)
            ]
    return problems


def test_every_docstring_is_complete():
    offenders = []
    for path in backend_python_files():
        relative_path = path.relative_to(BACKEND_DIR)
        offenders += [
            f"{relative_path}:{line} {problem}"
            for line, problem in incomplete_docstrings_in(
                path.read_text(encoding="utf-8")
            )
        ]
    failure_message = "Complete these docstrings:\n" + "\n".join(offenders)
    assert offenders == [], failure_message


def test_still_finds_docstrings():
    """
    Guard against a helper silently matching nothing.
    """
    source = (
        '"""\nModule.\n"""\n\n\ndef total():\n    """\n    Sum.\n    """\n'
    )
    assert len(list(docstring_nodes(ast.parse(source)))) == 2


def _problems(function_source):
    """
    Check one function inside an otherwise documented module.

    :param function_source: the function's source code.
    :returns: the problems found, without line numbers.
    """
    source = '"""\nModule.\n"""\n\n\n' + function_source
    return [problem for _line, problem in incomplete_docstrings_in(source)]


def test_detects_missing_docstrings():
    assert _problems("def total(count):\n    return count\n") == [
        "total() has no docstring"
    ]
    assert _problems("class Store:\n    pass\n") == [
        "class Store: no docstring"
    ]
    assert incomplete_docstrings_in("VALUE = 1\n") == [
        (1, "module: no docstring")
    ]


def test_detects_undocumented_parameters_and_result():
    source = (
        "def total(count, *extra):\n"
        '    """\n    Add up.\n    """\n'
        "    return count\n"
    )
    assert _problems(source) == [
        'total() has no ":param count:"',
        'total() has no ":param extra:"',
        'total() returns a value but has no ":returns:"',
    ]


def test_detects_generators_without_yields():
    source = 'def numbers():\n    """\n    Count.\n    """\n    yield 1\n'
    assert _problems(source) == ['numbers() yields but has no ":yields:"']


def test_detects_protocol_stubs_without_returns():
    source = (
        "class Store:\n"
        '    """\n    A store.\n    """\n\n'
        "    def get(self) -> int:\n"
        '        """\n        Read.\n        """\n'
        "        pass\n"
    )
    assert _problems(source) == [
        'get() returns a value but has no ":returns:"'
    ]


def test_ignores_nested_functions_results():
    source = (
        "def outer():\n"
        '    """\n    Run inner.\n    """\n\n'
        "    def inner():\n"
        '        """\n        Make one.\n\n        :returns: 1.\n        """\n'
        "        return 1\n\n"
        "    inner()\n"
    )
    assert _problems(source) == []


def test_accepts_complete_docstrings_and_exempt_names():
    source = (
        "def total(self, count):\n"
        '    """\n    Add up.\n\n'
        "    :param count: how many.\n    :returns: the total.\n"
        '    """\n'
        "    return count\n\n\n"
        "def test_total(client):\n"
        "    assert client\n\n\n"
        "def log(message):\n"
        '    """\n    Print it.\n\n    :param message: the text.\n    """\n'
        "    return None\n"
    )
    assert _problems(source) == []
