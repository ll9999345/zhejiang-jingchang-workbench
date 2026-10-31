"""Run only inspected pure normalizers from the pinned reference, never main.py.
No source imports, file I/O functions, process tools or network clients are exposed
inside the reference namespace. This verifies actual normalized output semantics.
"""
import ast
import hashlib
import json
from pathlib import Path
import re
import sys
from types import SimpleNamespace

source_file, payload_file = map(Path, sys.argv[1:3])
source = source_file.read_bytes()
expected = '2e0b1f0903d809715d92a982b849674a59292e7a89f3c2b7dbc44fd130080e8e'
assert hashlib.sha256(source).hexdigest() == expected
names = {'normalize_prompt_libraries', 'normalize_prompt_library_item', 'normalize_prompt_template_categories', 'normalize_prompt_category_id', 'sanitize_asset_name', 'default_prompt_libraries', 'seed_system_prompt_library', 'defaultPromptTemplateCategories'}
tree = ast.parse(source.decode())
functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
assert {node.name for node in functions} == names
allowed_calls = names | {'isinstance', 'dict', 'list', 'str', 'int', 'set', 'any', 'next', 'now_ms', 'builtin_prompt_templates', 'add_category'}
allowed_methods = {'get', 'strip', 'sub', 'uuid4', 'add', 'append'}
for function in functions:
    for node in ast.walk(function):
        assert not isinstance(node, (ast.Import, ast.ImportFrom, ast.Global, ast.Nonlocal, ast.ClassDef, ast.AsyncFunctionDef))
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name):
                assert node.func.id in allowed_calls, node.func.id
            elif isinstance(node.func, ast.Attribute):
                assert node.func.attr in allowed_methods, node.func.attr
            else:
                raise AssertionError('Unsupported reference call')
namespace = {'__builtins__': {'isinstance': isinstance, 'dict': dict, 'list': list, 'str': str, 'int': int, 'set': set, 'any': any, 'next': next}, 're': re, 'uuid': SimpleNamespace(uuid4=lambda: SimpleNamespace(hex='fixture_fixed_uuid')), 'now_ms': lambda: 1792360000000, 'builtin_prompt_templates': lambda: []}
exec(compile(ast.Module(body=functions, type_ignores=[]), '<inspected-prompt-normalizers>', 'exec'), namespace)
payload = json.loads(payload_file.read_text())
normalized = namespace['normalize_prompt_libraries'](payload)
print(json.dumps({'sourceSha256': expected, 'functions': sorted(names), 'normalized': normalized}, ensure_ascii=False))
