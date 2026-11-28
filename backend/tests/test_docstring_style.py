"""
Guard: every backend docstring has one layout and uses reST (Sphinx) fields.

One style everywhere makes docstrings quicker to read and lets tools parse
them. Every docstring, even a one-sentence one, puts its opening and closing
quotes on lines of their own::

    \"\"\"
    Return the store.
    \"\"\"

(ruff's D213/D209 only enforce this for multi-line docstrings, so this test
covers the one-line ones too.) Parameters, return values and errors are
written as fields::

    :param environ: where to read variables from.
    :returns: the validated Settings.
    :raises ConfigError: listing every missing or invalid variable.

(also :yields: for generators and :ivar name: for class attributes).
Google-style sections ("Args:", "Returns:", ...) are refused, and so are the
short spellings (return, raise, yield), so a field is always spelled one way.
"""

import ast
import re

from tests.test_naming import BACKEND_DIR, backend_python_files

# Google-style section headers that must be written as reST fields instead.
GOOGLE_SECTION = re.compile(
    r"^\s*(Args|Arguments|Parameters|Attributes|Returns|Return|Raises|"
    r"Yields|Yield):\s*$"
)

# Other spellings of the same reST fields, and the one form to use instead.
PREFERRED_FIELD = {
    "return": "returns",
    "raise": "raises",
    "yield": "yields",
    "arg": "param",
    "argument": "param",
}
NON_STANDARD_FIELD = re.compile(r"^\s*:(" + "|".join(PREFERRED_FIELD) + r")\b")

# A ":param name:" field; group 1 is the documented parameter name.
PARAM_FIELD = re.compile(r"^\s*:param (\w+):", re.MULTILINE)

# What may stand alone on a docstring's opening line: the quotes, optionally
# with the raw-string prefix.
OPENING_QUOTES = ('"""', 'r"""', 'R"""')
CLOSING_QUOTES = '"""'

# Nodes that can carry a docstring.
DOCUMENTED_NODES = (
    ast.Module,
    ast.ClassDef,
    ast.FunctionDef,
    ast.AsyncFunctionDef,
)


def docstrings_in(tree):
    """
    Yield (line number, docstring) for every documented node.

    :param tree: a parsed module.
    :yields: the first line of each docstring and its text.
    """
    for docstring_node in docstring_nodes(tree):
        yield docstring_node.lineno, docstring_node.value


def docstring_nodes(tree):
    """
    Yield the string node of every docstring.

    :param tree: a parsed module.
    :yields: each docstring's ast.Constant, which carries its text and its
        first and last line.
    """
    for node in ast.walk(tree):
        if not isinstance(node, DOCUMENTED_NODES) or not node.body:
            continue
        first_statement = node.body[0]
        if (
            isinstance(first_statement, ast.Expr)
            and isinstance(first_statement.value, ast.Constant)
            and isinstance(first_statement.value.value, str)
        ):
            yield first_statement.value


def layout_problem(source_lines, docstring_node):
    """
    Explain why a docstring's quotes are not on lines of their own.

    :param source_lines: the module's source, split into lines.
    :param docstring_node: the docstring's ast.Constant node.
    :returns: a short reason, or None when the layout is right.
    """
    opening_line = source_lines[docstring_node.lineno - 1].strip()
    closing_line = source_lines[docstring_node.end_lineno - 1].strip()
    if opening_line not in OPENING_QUOTES:
        return 'text starts on the opening """ line'
    if closing_line != CLOSING_QUOTES:
        return 'closing """ is not on its own line'
    return None


def layout_problems_in(source):
    """
    Find every docstring in one module whose quotes share a line with text.

    :param source: the module's source code.
    :returns: (line number, reason) for each badly laid-out docstring.
    """
    source_lines = source.splitlines()
    return [
        (docstring_node.lineno, problem)
        for docstring_node in docstring_nodes(ast.parse(source))
        if (problem := layout_problem(source_lines, docstring_node))
    ]


def style_problems(docstring):
    """
    Explain every non-reST line in one docstring.

    :param docstring: the raw docstring text.
    :returns: one message per offending line (empty when it is fine).
    """
    problems = []
    for line in docstring.splitlines():
        if GOOGLE_SECTION.match(line):
            problems.append(f'"{line.strip()}" section: use :param/:returns:')
        elif match := NON_STANDARD_FIELD.match(line):
            field = match.group(1)
            problems.append(
                f'":{field}:" field: spell it ":{PREFERRED_FIELD[field]}:"'
            )
    return problems


def parameter_names(function):
    """
    Every parameter a function declares, including *args and **kwargs.

    :param function: a parsed function definition.
    :returns: the parameter names.
    """
    arguments = function.args
    names = {
        argument.arg
        for argument in arguments.posonlyargs
        + arguments.args
        + arguments.kwonlyargs
    }
    for variadic in (arguments.vararg, arguments.kwarg):
        if variadic is not None:
            names.add(variadic.arg)
    return names


def stale_param_names(function):
    """
    Names in ":param name:" fields that the function does not declare.

    A parameter renamed in code but not in its docstring shows up here.

    :param function: a parsed function definition.
    :returns: the documented names that are not real parameters.
    """
    docstring = ast.get_docstring(function) or ""
    real_names = parameter_names(function)
    return [
        name
        for name in PARAM_FIELD.findall(docstring)
        if name not in real_names
    ]


def test_every_param_field_names_a_real_parameter():
    offenders = []
    for path in backend_python_files():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        relative_path = path.relative_to(BACKEND_DIR)
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                offenders += [
                    f"{relative_path}:{node.lineno} {node.name}() has no "
                    f"parameter {name!r}"
                    for name in stale_param_names(node)
                ]
    assert offenders == [], "Fix :param names:\n" + "\n".join(offenders)


def test_detects_stale_param_names():
    function = ast.parse(
        'def resolve(did_document):\n    """\n    Summary.\n\n'
        '    :param doc: the document.\n    """\n'
    ).body[0]
    assert stale_param_names(function) == ["doc"]


def test_accepts_variadic_param_names():
    function = ast.parse(
        'def build(**overrides):\n    """\n    Summary.\n\n'
        '    :param overrides: field values.\n    """\n'
    ).body[0]
    assert stale_param_names(function) == []


def test_every_docstring_uses_rest_fields():
    offenders = []
    for path in backend_python_files():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        relative_path = path.relative_to(BACKEND_DIR)
        for line, docstring in docstrings_in(tree):
            offenders += [
                f"{relative_path}:{line} {problem}"
                for problem in style_problems(docstring)
            ]
    assert offenders == [], "Use reST docstring fields:\n" + "\n".join(
        offenders
    )


def test_every_docstring_puts_its_quotes_on_their_own_lines():
    offenders = []
    for path in backend_python_files():
        relative_path = path.relative_to(BACKEND_DIR)
        offenders += [
            f"{relative_path}:{line} {problem}"
            for line, problem in layout_problems_in(
                path.read_text(encoding="utf-8")
            )
        ]
    failure_message = (
        'Put """ on its own line, above and below the text:\n'
        + "\n".join(offenders)
    )
    assert offenders == [], failure_message


def test_detects_one_line_docstrings():
    source = 'def total():\n    """Return the total."""\n'
    assert layout_problems_in(source) == [
        (2, 'text starts on the opening """ line')
    ]


def test_detects_text_on_the_opening_line():
    source = 'def total():\n    """Return the total.\n    """\n'
    assert layout_problems_in(source) == [
        (2, 'text starts on the opening """ line')
    ]


def test_detects_text_on_the_closing_line():
    source = 'def total():\n    """\n    Return the total."""\n'
    assert layout_problems_in(source) == [
        (2, 'closing """ is not on its own line')
    ]


def test_accepts_quotes_on_their_own_lines():
    source = (
        '"""\nModule summary.\n"""\n\n'
        'def total():\n    """\n    Return the total.\n    """\n'
    )
    assert layout_problems_in(source) == []


def test_detects_google_sections():
    docstring = "Summary.\n\nArgs:\n    name: the name.\n\nReturns:\n    x."
    assert style_problems(docstring) == [
        '"Args:" section: use :param/:returns:',
        '"Returns:" section: use :param/:returns:',
    ]


def test_detects_non_standard_field_spellings():
    assert style_problems(":return: the value.") == [
        '":return:" field: spell it ":returns:"'
    ]
    assert style_problems(":raise ValueError: when bad.") == [
        '":raise:" field: spell it ":raises:"'
    ]
    assert style_problems(":arg name: the name.") == [
        '":arg:" field: spell it ":param:"'
    ]


def test_accepts_rest_fields_and_prose():
    docstring = (
        "Summary.\n\n"
        "The Returns of a function are described below.\n\n"
        ":param name: the name.\n"
        ":returns: the value.\n"
        ":raises ValueError: when bad.\n"
        ":yields: frames.\n"
        ":ivar problems: messages."
    )
    assert style_problems(docstring) == []
