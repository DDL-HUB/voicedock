"""Loopback Flash bridge. A pairing code protects every voice and audio route."""
import hmac
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cloud_provider
from audio_edges import trim_edges
from cloud_credentials import DATA_DIR, FILE

PORT = 8766
PAIRING_FILE = DATA_DIR / 'pairing-code'
PAIRING_HEADER = 'X-VoiceDock-Pairing'
EXTENSION_ORIGIN = re.compile(r'chrome-extension://[a-p]{32}')
PREFIX = '/voicedock'
SYNTH_LOCK = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def origin_allowed(self):
        origin = self.headers.get('Origin', '')
        return self.headers.get('Host') == f'127.0.0.1:{PORT}' and (
            not origin or EXTENSION_ORIGIN.fullmatch(origin) is not None
        )

    def paired(self):
        supplied = self.headers.get(PAIRING_HEADER, '')
        if not re.fullmatch(r'[A-Za-z0-9_-]{43}', supplied):
            return False
        return hmac.compare_digest(supplied, self.server.pairing_code)

    def respond(self, code, payload=None, content_type='application/json'):
        if payload is None:
            body = b''
        elif isinstance(payload, bytes):
            body = payload
        else:
            body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        origin = self.headers.get('Origin')
        if origin and self.origin_allowed():
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
            if self.command == 'OPTIONS':
                self.send_header('Access-Control-Allow-Headers', f'Content-Type, {PAIRING_HEADER}')
                self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        try:
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def authorize(self):
        if not self.origin_allowed():
            self.respond(403, {'error': '只允许本机扩展连接。'})
            return False
        if not self.paired():
            self.respond(401, {'error': '请在扩展设置中填写本机连接码。'})
            return False
        return True

    def do_OPTIONS(self):
        self.respond(204 if self.origin_allowed() else 403)

    def do_GET(self):
        if not self.authorize():
            return
        if self.path == PREFIX + '/health':
            self.respond(200, {'status': 'ok', 'engine': 'piper', 'version': 'flash'})
        elif self.path == PREFIX + '/voices':
            voices = cloud_provider.public_voices()
            self.respond(200, {'voices': [voice['id'] for voice in voices], 'voiceDetails': voices})
        else:
            self.respond(404, {'error': '接口不存在。'})

    def do_POST(self):
        if not self.authorize():
            return
        try:
            if self.headers.get_content_type() != 'application/json':
                raise ValueError('需要 JSON 请求。')
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 32_768:
                raise ValueError('请求为空或过大。')
            data = json.loads(self.rfile.read(size))
            if not isinstance(data, dict):
                raise ValueError('请求格式错误。')
            if self.path == PREFIX + '/cloud-voices/refresh':
                return self.respond(200, {'voices': cloud_provider.sync_voices()})
            if self.path == PREFIX + '/cloud-voices/rename':
                return self.respond(200, {'voices': cloud_provider.rename_voice(data.get('id'), data.get('name'))})
            if self.path not in (PREFIX + '/tts', PREFIX + '/cached-tts'):
                return self.respond(404, {'error': '接口不存在。'})
            text, alias = data.get('text'), data.get('voice')
            if not isinstance(text, str) or not 0 < len(text) <= 5000:
                raise ValueError('每段朗读文字限 1–5000 个字符。')
            if not isinstance(alias, str) or not any(v['id'] == alias for v in cloud_provider.public_voices()):
                raise ValueError('请从已同步的音色列表中选择音色。')
            voice_id = None if alias == 'flash-default' else alias.removeprefix('cloud:')
            if self.path.endswith('/cached-tts'):
                audio = cloud_provider.cached(text, voice_id)
                return self.respond(200, trim_edges(audio), 'audio/wav') if audio else self.respond(204)
            if not SYNTH_LOCK.acquire(blocking=False):
                return self.respond(429, {'error': '正在合成上一段，请稍候。'})
            try:
                audio = cloud_provider.synthesize(text, voice_id)
                return self.respond(200, trim_edges(audio), 'audio/wav')
            finally:
                SYNTH_LOCK.release()
        except (ValueError, KeyError, TypeError) as error:
            self.respond(400, {'error': str(error)})
        except (OSError, IndexError):
            self.respond(502, {'error': '语音服务暂不可用。请检查本机凭据及云端连接。'})


def main():
    if not FILE.is_file() or not PAIRING_FILE.is_file() or not cloud_provider.enabled():
        raise SystemExit('请先运行 setup-cloud.cmd。')
    pairing_code = PAIRING_FILE.read_text(encoding='ascii').strip()
    if not re.fullmatch(r'[A-Za-z0-9_-]{43}', pairing_code):
        raise SystemExit('连接码无效，请重新运行 setup-cloud.cmd。')
    with ThreadingHTTPServer(('127.0.0.1', PORT), Handler) as server:
        server.pairing_code = pairing_code
        print(f'VoiceDock 云端服务已就绪 · 127.0.0.1:{PORT}', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
