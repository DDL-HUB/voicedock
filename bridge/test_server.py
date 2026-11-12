import http.client
import json
import io
import os
import secrets
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

import server
import cloud_credentials
import configure


class ConfigureTests(unittest.TestCase):
    @unittest.skipUnless(os.name == 'nt', 'Windows DPAPI')
    def test_setup_stores_encrypted_credentials_outside_the_installation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            key = 'synthetic-test-value'
            credentials = root / 'cloud-keys.dpapi'
            with patch.object(cloud_credentials, 'FILE', credentials), \
                    patch.object(server.cloud_provider, 'CONFIG', root / 'cloud-config.json'), \
                    patch.object(configure, 'PAIRING_FILE', root / 'pairing-code'), \
                    patch('getpass.getpass', return_value=key), redirect_stdout(io.StringIO()):
                configure.main()
                self.assertEqual(cloud_credentials.load(), [key])
                self.assertNotIn(key.encode(), credentials.read_bytes())
                self.assertEqual(len((root / 'pairing-code').read_text()), 43)


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.bridge = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.bridge.pairing_code = secrets.token_urlsafe(32)
        self.thread = threading.Thread(target=self.bridge.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.bridge.server_close)
        self.addCleanup(self.bridge.shutdown)

    def request(self, method, route, data=None, paired=True, **extra_headers):
        headers = {'Host': f'127.0.0.1:{server.PORT}'}
        if paired:
            headers[server.PAIRING_HEADER] = self.bridge.pairing_code
        if data is not None:
            headers['Content-Type'] = 'application/json'
        headers.update(extra_headers)
        connection = http.client.HTTPConnection('127.0.0.1', self.bridge.server_port, timeout=4)
        try:
            connection.request(method, '/voicedock' + route, json.dumps(data) if data is not None else None, headers)
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def test_unpaired_or_web_origin_never_reaches_billable_synthesis(self):
        with patch.object(server.cloud_provider, 'synthesize') as synthesize:
            data = {'text': 'Example sentence.', 'voice': 'cloud:demo'}
            self.assertEqual(self.request('POST', '/tts', data, paired=False)[0], 401)
            self.assertEqual(self.request('POST', '/tts', data, Origin='https://example.test')[0], 403)
            handler = object.__new__(server.Handler)
            handler.headers = {'Host': 'example.test'}
            self.assertFalse(handler.origin_allowed())
            synthesize.assert_not_called()

    def test_paired_catalog_and_cached_audio_use_selected_voice(self):
        voices = [{'id': 'cloud:demo', 'name': 'Demo'}]
        with patch.object(server.cloud_provider, 'public_voices', return_value=voices), \
                patch.object(server.cloud_provider, 'cached', return_value=None) as cached, \
                patch.object(server.cloud_provider, 'synthesize') as synthesize:
            code, body = self.request('GET', '/voices', Origin='chrome-extension://' + 'a'*32)
            self.assertEqual(code, 200)
            self.assertEqual(json.loads(body)['voiceDetails'], voices)
            self.assertEqual(self.request('POST', '/cached-tts', {'text': 'Example.', 'voice': 'cloud:demo'})[0], 204)
            cached.assert_called_once_with('Example.', 'demo')
            self.assertEqual(self.request('POST', '/tts', {'text': 'Example.', 'voice': 'cloud:unknown'})[0], 400)
            synthesize.assert_not_called()
