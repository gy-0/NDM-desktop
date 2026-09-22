import hashlib
import importlib.util
from pathlib import Path
import shutil
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('relay_package', Path(__file__).with_name('package-relay-store.py'))
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)


class RelayStorePackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='ndm-relay-package-')
        self.root = Path(self.temporary.name)
        self.source = self.root / 'extension'
        shutil.copytree(relay.ROOT / 'extension/NDMRelay', self.source)

    def tearDown(self):
        self.temporary.cleanup()

    def test_reproducible_runtime_preserves_notices_and_excludes_development_files(self):
        (self.source / '.env').write_text('synthetic private development setting')
        before = {str(p.relative_to(self.source)): hashlib.sha256(p.read_bytes()).hexdigest()
                  for p in self.source.rglob('*') if p.is_file()}
        first = relay.package(self.source, self.root / 'first.zip')
        second = relay.package(self.source, self.root / 'second.zip')
        self.assertEqual(first['sha256'], second['sha256'])
        with zipfile.ZipFile(self.root / 'first.zip') as archive:
            self.assertIn('manifest.json', archive.namelist())
            self.assertIn('LICENSE', archive.namelist())
            self.assertNotIn('package.json', archive.namelist())
            self.assertNotIn('.env', archive.namelist())
            self.assertFalse(any(name.startswith('tests/') for name in archive.namelist()))
            self.assertEqual(archive.read('bg.js'), (self.source / 'bg.js').read_bytes())
        self.assertEqual(before, {str(p.relative_to(self.source)): hashlib.sha256(p.read_bytes()).hexdigest()
                                 for p in self.source.rglob('*') if p.is_file()})
        with self.assertRaises(FileExistsError):
            relay.package(self.source, self.root / 'first.zip')
        self.assertEqual(hashlib.sha256((self.root / 'first.zip').read_bytes()).hexdigest(), first['sha256'])

    def test_missing_popup_font_fails_before_creating_archive(self):
        (self.source / 'fonts/instrument-serif-latin-400-normal.woff2').unlink()
        with self.assertRaisesRegex(ValueError, 'Missing packaged resource'):
            relay.package(self.source, self.root / 'missing.zip')
        self.assertFalse((self.root / 'missing.zip').exists())

    def test_missing_import_is_rejected(self):
        with (self.source / 'bg.js').open('a') as stream:
            stream.write('\nimportScripts("absent.js");')
        with self.assertRaisesRegex(ValueError, 'absent.js'):
            relay.collect(self.source)

    def test_version_mismatch_is_rejected(self):
        (self.source / 'package.json').write_text('{"version":"0.0.1"}')
        with self.assertRaisesRegex(ValueError, 'versions differ'):
            relay.collect(self.source)

    def test_linked_assets_are_rejected(self):
        icon = self.source / 'img/icon16.png'
        icon.unlink()
        try:
            icon.symlink_to(self.source / 'img/icon48.png')
        except OSError:
            self.skipTest('Symlink creation unavailable on this host')
        with self.assertRaisesRegex(ValueError, 'Linked asset'):
            relay.collect(self.source)

    def test_unresolved_manifest_description_is_rejected(self):
        import json
        path = self.source / '_locales/zh_CN/messages.json'
        catalog = json.loads(path.read_text())
        del catalog['extDescription']
        path.write_text(json.dumps(catalog))
        with self.assertRaisesRegex(ValueError, 'Invalid localized description'):
            relay.collect(self.source)


if __name__ == '__main__':
    unittest.main()
