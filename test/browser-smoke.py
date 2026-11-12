"""Verify the Windows release archive in a fresh Edge profile with mock speech."""
import io
import os
import secrets
import sys
import tempfile
import threading
import wave
from pathlib import Path
from zipfile import ZipFile

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'bridge'))
import server

voice = {'id': 'cloud:cosyvoice-v3.5-flash-demo', 'name': 'Demo', 'model': 'cosyvoice-v3.5-flash'}
requests = []
buffer = io.BytesIO()
with wave.open(buffer, 'wb') as audio:
    audio.setnchannels(1)
    audio.setsampwidth(2)
    audio.setframerate(24000)
    audio.writeframes(b'\0\0' * 96000)


def synthesize(text, voice_id):
    requests.append((text, voice_id))
    return buffer.getvalue()


server.cloud_provider.public_voices = lambda: [voice]
server.cloud_provider.sync_voices = lambda: [voice]
server.cloud_provider.synthesize = synthesize

fixture = 'A reader opens a book. This is a second sentence.'
url = 'https://weread.qq.com/web/reader/release-smoke'
edge = Path(os.environ.get('ProgramFiles(x86)', 'C:/Program Files (x86)')) / 'Microsoft/Edge/Application/msedge.exe'
archive = next((ROOT / 'release').glob('*-windows.zip'))

with server.ThreadingHTTPServer(('127.0.0.1', server.PORT), server.Handler) as bridge:
    bridge.pairing_code = secrets.token_urlsafe(32)
    threading.Thread(target=bridge.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix='voicedock-smoke-', ignore_cleanup_errors=True) as scratch:
            installation = Path(scratch) / 'install'
            with ZipFile(archive) as package:
                package.extractall(installation)
            extension = installation / 'extension'
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch_persistent_context(
                    str(Path(scratch) / 'profile'), executable_path=str(edge),
                    headless=True, args=[
                        '--load-extension=' + str(extension),
                        '--disable-extensions-except=' + str(extension),
                        '--autoplay-policy=no-user-gesture-required',
                    ]
                )
                try:
                    browser.route(url, lambda route: route.fulfill(
                        content_type='text/html; charset=utf-8',
                        body=f'<div class="readerChapterContent"><p>{fixture}</p></div>'
                    ))
                    worker = browser.service_workers[0] if browser.service_workers else browser.wait_for_event('serviceworker')
                    extension_id = worker.url.split('/')[2]
                    origin = 'chrome-extension://' + extension_id
                    worker.evaluate("""()=>{
                      globalThis.mockBrowserSpeech=[];
                      chrome.tts.speak=(text,options,callback)=>{
                        mockBrowserSpeech.push(text);callback?.();options.onEvent({type:'start'});
                      };
                      chrome.tts.stop=()=>{};
                    }""")
                    page = browser.new_page()
                    page.goto(url)
                    popup = browser.new_page()
                    popup.goto(origin + '/popup.html')
                    expect(popup.get_by_text('浏览器语音', exact=True).first).to_be_visible()

                    def read():
                        page.bring_to_front()
                        page.locator('.readerChapterContent p').evaluate("""element=>{
                          const range=document.createRange();range.selectNodeContents(element);
                          const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
                          document.dispatchEvent(new Event('selectionchange'));
                        }""")
                        popup.get_by_role('button', name='从这里往后读', exact=True).evaluate('button=>button.click()')
                        try:
                            expect(page.locator('#vd-reading-highlight')).to_be_attached()
                        except AssertionError as error:
                            state = popup.evaluate('()=>chrome.runtime.sendMessage({type:"get-playback-state"})')
                            raise AssertionError((state.get('progress'), requests)) from error

                    read()
                    assert worker.evaluate('()=>mockBrowserSpeech') == [fixture]
                    assert not requests, 'Fresh install must not call the cloud'
                    popup.evaluate('()=>chrome.runtime.sendMessage({type:"stop-all"})')

                    settings = browser.new_page()
                    settings.goto(origin + '/options.html')
                    settings.get_by_label('本机连接码').fill(bridge.pairing_code)
                    settings.get_by_role('checkbox').check()
                    settings.get_by_role('button', name='连接服务', exact=True).click()
                    expect(settings.get_by_role('status')).to_contain_text('连接成功')
                    popup.reload()
                    popup.get_by_role('button', name='同步平台音色', exact=True).click()
                    popup.get_by_label('朗读音色', exact=True).select_option(voice['id'])
                    expect(popup.get_by_text('Demo · Flash', exact=True).last).to_be_visible()
                    read()
                    assert requests == [(fixture, 'cosyvoice-v3.5-flash-demo')], requests
                    popup.evaluate('()=>chrome.runtime.sendMessage({type:"stop-all"})')
                    page.evaluate("""()=>{
                      const root=document.querySelector('.readerChapterContent');
                      root.querySelector('p').textContent='This sentence ends. The next thought';
                      const next=document.createElement('button');
                      next.textContent='下一页';
                      next.onclick=()=>{
                        root.querySelector('p').textContent='continues across the page.';
                        next.disabled=true;
                      };
                      root.after(next);
                    }""")
                    read()
                    for _ in range(100):
                        if requests[-1][0] == 'The next thought continues across the page.':
                            break
                        page.wait_for_timeout(100)
                    assert [text for text, _voice in requests[1:]] == [
                        'This sentence ends.', 'The next thought continues across the page.'
                    ], requests
                    expect(page.locator('#vd-reading-highlight')).to_be_attached()
                    popup.evaluate('()=>chrome.runtime.sendMessage({type:"stop-all"})')
                    settings.get_by_role('button', name='断开连接', exact=True).click()
                    expect(settings.get_by_role('status')).to_contain_text('已断开云端连接')
                    assert not worker.evaluate("async()=>Boolean((await chrome.storage.local.get('bridgePairingCode')).bridgePairingCode)")
                    print('Archive install, browser speech, consent, pairing, cloud audio, highlight and cross-page speech verified.')
                finally:
                    browser.close()
    finally:
        bridge.shutdown()
