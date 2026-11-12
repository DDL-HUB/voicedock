"""Build public archives from an explicit allowlist, never from a workspace tree."""
import hashlib
import json
import re
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'release'
VERSION = json.loads((ROOT / 'extension/manifest.json').read_text(encoding='utf-8'))['version']
EXTENSION = tuple('extension/' + name for name in (
    'manifest.json', 'background.js', 'content.js', 'offscreen.html', 'offscreen.js',
    'popup.html', 'popup.css', 'dist/popup.js', 'options.html', 'options.css', 'options.js',
    'reader.html', 'reader.js', 'reader-ball.js', 'reading.js', 'reading-content.js',
    'weread-canvas.js', 'src/shared.js', 'icons/icon16.png', 'icons/icon48.png',
    'icons/icon128.png', 'icons/icon512.png',
))
BRIDGE = tuple('bridge/' + name for name in (
    'server.py', 'configure.py', 'audio_edges.py', 'cloud_provider.py',
    'cloud_credentials.py', 'requirements.txt',
))
DOCS = ('LICENSE', 'README.md', 'PRIVACY.md', 'THIRD_PARTY.md', 'RELEASE_CHECKLIST.md')
INSTALL = EXTENSION + BRIDGE + DOCS + ('setup-cloud.cmd', 'start-cloud.cmd')
SOURCE = INSTALL + (
    '.gitignore', '.github/workflows/ci.yml', 'package.json', 'package-lock.json',
    'extension/src/popup.jsx', 'tools/build-extension-ui.mjs', 'tools/package-release.py',
    'bridge/test_audio_edges.py', 'bridge/test_cloud.py', 'bridge/test_server.py',
    'test/audio-queue.test.mjs', 'test/background-engines.test.mjs',
    'test/background-module.test.mjs', 'test/cloud-voice.test.mjs',
    'test/engines.test.mjs', 'test/popup-reader-race.test.mjs',
    'test/reading.test.mjs', 'test/shared.test.mjs',
    'test/browser-smoke.py',
)
PRIVATE_PATTERNS = (
    re.compile(rb'\bsk-[A-Za-z0-9_.-]{20,}'),
    re.compile(rb'cosyvoice-v3\.5-flash-bailian-[a-f0-9]{24,}', re.I),
    re.compile(rb'[A-Za-z]:[/\\](?:Users[/\\]|MARINDA\b)', re.I),
    re.compile('\u5e38\u77f3\u78ca|\u77f3\u59342'.encode('utf-8')),
)


def checked_file(relative):
    path = ROOT / relative
    if path.is_symlink() or not path.resolve().is_relative_to(ROOT) or not path.is_file():
        raise SystemExit(f'Missing or unsafe file: {relative}')
    data = path.read_bytes()
    if path.suffix != '.png' and any(pattern.search(data) for pattern in PRIVATE_PATTERNS):
        raise SystemExit(f'Possible private data in {relative}')
    return data


def write_zip(name, mapping, contents):
    target = OUTPUT / name
    with ZipFile(target, 'w', compression=ZIP_DEFLATED) as archive:
        for destination, relative in sorted(mapping):
            entry = ZipInfo(destination)
            entry.compress_type = ZIP_DEFLATED
            entry.external_attr = 0o644 << 16
            archive.writestr(entry, contents[relative])
    return target


def main():
    contents = {relative: checked_file(relative) for relative in SOURCE}
    OUTPUT.mkdir(exist_ok=True)
    prefix = f'VoiceDock-{VERSION}-candidate'
    archives = [
        write_zip(prefix + '-source.zip', ((path, path) for path in SOURCE), contents),
        write_zip(prefix + '-windows.zip', ((path, path) for path in INSTALL), contents),
        write_zip(prefix + '-extension.zip',
                  [(path.removeprefix('extension/'), path) for path in EXTENSION] +
                  [(path, path) for path in ('LICENSE', 'THIRD_PARTY.md', 'PRIVACY.md')], contents),
    ]
    checksums = ''.join(f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n' for path in archives)
    (OUTPUT / 'SHA256SUMS.txt').write_text(checksums, encoding='ascii')
    for archive in archives:
        print(archive.name)


if __name__ == '__main__':
    main()
