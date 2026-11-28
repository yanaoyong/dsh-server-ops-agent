"""Run the Python recovery suites, including tests that require Linux backup tools."""
import importlib.util
from pathlib import Path
import unittest


def load_tests(loader, tests, pattern):
    for path in sorted(Path(__file__).with_name('test').glob('*.test.py')):
        name = path.name.replace('-', '_').split('.')[0]
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        tests.addTests(loader.loadTestsFromModule(module))
    return tests


if __name__ == '__main__':
    unittest.main(verbosity=2)
