"""
Guard: every backend docstring uses the reST (Sphinx) field style.

One style everywhere makes docstrings quicker to read and lets tools parse
them. Parameters, return values and errors are written as fields::

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
    for node in ast.walk(tree):
        if not isinstance(node, DOCUMENTED_NODES):
            continue
        docstring = ast.get_docstring(node, clean=False)
        if docstring is not None:
            yield node.body[0].lineno, docstring


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
