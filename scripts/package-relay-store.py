#!/usr/bin/env python3
"""Build the reviewed Relay runtime as a reproducible Web Store upload ZIP."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import zipfile

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = (
    'manifest.json', 'LICENSE', 'bg.js', 'browser-handoff.js', 'click-handoff.js',
    'click-catcher.js', 'ct.js', 'media-policy.js', 'resource-policy.js',
    'site-adapters.js', 'session-cookies.js', 'relay-outbox.js',
    'popup.html', 'popup.js', 'popup.css',
)


def collect(source):
    source = Path(source).resolve()
    names = set(RUNTIME)
    for directory, suffixes in [('img', {'.png'}), ('fonts', {'.woff2'}), ('_locales', {'.json'})]:
        base = source / directory
        if base.is_symlink() or not base.is_dir():
            raise ValueError(f'Missing or linked asset directory: {directory}')
        for path in base.rglob('*'):
            if path.is_symlink():
                raise ValueError(f'Linked asset: {path.relative_to(source)}')
            if path.is_file() and path.suffix in suffixes:
                names.add(path.relative_to(source).as_posix())
    content = {}
    for name in sorted(names):
        path = source / name
        if path.is_symlink() or not path.is_file():
            raise ValueError(f'Missing or linked runtime file: {name}')
        content[name] = path.read_bytes()
    manifest = json.loads(content['manifest.json'])
    package = json.loads((source / 'package.json').read_text())
    version = manifest.get('version', '')
    if manifest.get('manifest_version') != 3 or not isinstance(version, str) or not re.fullmatch(r'[0-9]+(?:\.[0-9]+){0,3}', version):
        raise ValueError('A valid Manifest V3 version is required')
    if any(int(part) > 65535 or (len(part) > 1 and part.startswith('0')) for part in version.split('.')) or not any(int(part) for part in version.split('.')):
        raise ValueError('Invalid Chrome extension version')
    if package.get('version') != version:
        raise ValueError('manifest.json and package.json versions differ')

    def require(name, parent=''):
        if not isinstance(name, str) or '\\' in name or '?' in name or '#' in name:
            raise ValueError(f'Invalid packaged resource: {name}')
        path = PurePosixPath(parent) / name
        if path.is_absolute() or '..' in path.parts or str(path) not in content:
            raise ValueError(f'Missing packaged resource: {path}')

    require(manifest['background']['service_worker'])
    require(manifest['action']['default_popup'])
    for icons in [manifest.get('icons', {}), manifest['action'].get('default_icon', {})]:
        for icon in icons.values():
            require(icon)
    for group in manifest.get('content_scripts', []):
        for name in group.get('js', []) + group.get('css', []):
            require(name)
    for group in manifest.get('web_accessible_resources', []):
        for name in group['resources']:
            require(name)
    require(f"_locales/{manifest['default_locale']}/messages.json")
    catalogs = {name: json.loads(data) for name, data in content.items()
                if name.startswith('_locales/') and name.endswith('/messages.json')}
    fallback = catalogs[f"_locales/{manifest['default_locale']}/messages.json"]
    for name, catalog in catalogs.items():
        for field, limit in [('name', 75), ('description', 132)]:
            value = manifest.get(field, '')
            localized = re.fullmatch(r'__MSG_(.+)__', value)
            if localized:
                entry = catalog.get(localized[1], fallback.get(localized[1], {}))
                value = entry.get('message', '')
            if not isinstance(value, str) or not value.strip() or len(value.encode('utf-16-le')) // 2 > limit:
                raise ValueError(f'Invalid localized {field}: {name}')
    for name, data in content.items():
        parent = str(PurePosixPath(name).parent)
        if name.endswith('.js'):
            for call in re.findall(r'\bimportScripts\(([^)]*)\)', data.decode()):
                for reference in re.findall(r'''["']([^"']+)["']''', call):
                    require(reference, parent)
        elif name.endswith('.html'):
            for reference in re.findall(r'''(?:src|href)=["']([^"']+)["']''', data.decode()):
                require(reference, parent)
        elif name.endswith('.css'):
            for reference in re.findall(r'''url\(["']?([^\s"')]+)["']?\)''', data.decode()):
                require(reference, parent)
    return version, content


def package(source, output):
    version, content = collect(source)
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive creation preserves any existing reviewed upload artifact.
    with output.open('xb') as destination:
        with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, data in content.items():
                info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                archive.writestr(info, data, compresslevel=9)
    with zipfile.ZipFile(output) as archive:
        if archive.testzip() or archive.namelist() != list(content):
            raise ValueError('ZIP integrity or file list mismatch')
        for name, data in content.items():
            if archive.read(name) != data:
                raise ValueError(f'ZIP content mismatch: {name}')
    return {'version': version, 'path': str(output.resolve()), 'files': len(content),
            'sha256': hashlib.sha256(output.read_bytes()).hexdigest()}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path, help='New ZIP path; existing files are never replaced')
    args = parser.parse_args()
    print(json.dumps(package(ROOT / 'extension/NDMRelay', args.output), indent=2))
