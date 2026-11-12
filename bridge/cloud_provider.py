"""CosyVoice Flash adapter. Credentials remain in the Windows user's DPAPI store."""
import json,io,uuid,wave,time,hashlib,threading,re
import requests
from pathlib import Path
import websocket
from cloud_credentials import DATA_DIR, load as credentials
CONFIG=DATA_DIR/'cloud-config.json'
CACHE=DATA_DIR/'audio-cache'
CONFIG_LOCK=threading.Lock()
def config():return json.loads(CONFIG.read_text(encoding='utf-8')) if CONFIG.exists() else {}
def enabled():return config().get('enabled') is True
def voice_entries(options=None):
    options=config() if options is None else options
    entries={v['voice_id']:dict(v) for v in options.get('voices',[]) if v.get('voice_id','').startswith('cosyvoice-v3.5-flash-')}
    default=options.get('voice_id','')
    if default:entries[default]={'voice_id':default,'name':options.get('name','默认音色'),'key_index':options.get('key_index',0)}
    return list(entries.values())

def public_voices():
    options=config();default=options.get('voice_id')
    return [{'id':'flash-default' if v['voice_id']==default else 'cloud:'+v['voice_id'],'name':v.get('name','Flash 音色'),'model':'cosyvoice-v3.5-flash'}for v in voice_entries(options) if v.get('visible',True)]

def save_config(options):
    CONFIG.parent.mkdir(parents=True,exist_ok=True)
    temporary=CONFIG.with_suffix('.tmp');temporary.write_text(json.dumps(options,ensure_ascii=False,indent=2),encoding='utf-8');temporary.replace(CONFIG)

def sync_voices():
    options=config();key=credentials()[options.get('key_index',0)]
    try:
        found=[]
        for page in range(10):
            response=requests.post('https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization',headers={'Authorization':'Bearer '+key},json={'model':'voice-enrollment','input':{'action':'list_voice','page_index':page,'page_size':100}},timeout=30,allow_redirects=False)
            if response.status_code!=200:raise ValueError('无法同步音色，请检查网络、API权限和服务状态。')
            batch=response.json().get('output',{}).get('voice_list',[]);found.extend(batch)
            if len(batch)<100:break
    except (requests.RequestException,json.JSONDecodeError):raise ValueError('音色同步失败，请稍后重试。') from None
    with CONFIG_LOCK:
        options=config();old={v['voice_id']:v for v in options.get('hidden_voices',[])}
        old.update({v['voice_id']:v for v in voice_entries(options)})
        entries=[]
        for voice in found:
            if voice.get('status')!='OK' or voice.get('target_model')!='cosyvoice-v3.5-flash':continue
            vid=voice['voice_id'];entries.append({'voice_id':vid,'name':old.get(vid,{}).get('name',f'Flash 音色 {len(entries)+1}'),'visible':old.get(vid,{}).get('visible',True),'key_index':options.get('key_index',0)})
        options['voices']=[v for v in entries if v.get('visible',True)]
        options['hidden_voices']=[v for v in entries if not v.get('visible',True)]
        save_config(options)
    return public_voices()

def rename_voice(alias,name):
    name=str(name).strip()
    if not 1<=len(name)<=60:raise ValueError('音色名称需为1–60个字符。')
    with CONFIG_LOCK:
        options=config();vid=options.get('voice_id') if alias=='flash-default' else str(alias).removeprefix('cloud:')
        entries=voice_entries(options)
        if not any(v['voice_id']==vid for v in entries):raise ValueError('音色不存在，请先同步。')
        for voice in entries:
            if voice['voice_id']==vid:voice['name']=name
        options['voices']=entries
        if vid==options.get('voice_id'):options['name']=name
        save_config(options)
    return public_voices()

def cached(text,voice_id=None):
    text=' '.join(str(text).split());options=config();voice=voice_id or options.get('voice_id','')
    if not any(v['voice_id']==voice and v.get('visible',True)for v in voice_entries(options)):return None
    key=hashlib.sha256(json.dumps([options.get('model'),voice,text,'pcm24000-rate1-v1'],ensure_ascii=False).encode()).hexdigest()
    path=CACHE/(key+'.wav')
    if path.exists():
        audio=path.read_bytes()
        if audio.startswith(b'RIFF')and len(audio)>44:return audio
    return None

def synthesize(text,voice_id=None):
    text=' '.join(text.split())
    if not any(c.isalnum() for c in text):raise ValueError('这段只有标点或空白，没有可朗读的文本。')
    options=config();model=options.get('model');voice=voice_id or options.get('voice_id','')
    entry=next((v for v in voice_entries(options) if v['voice_id']==voice and v.get('visible',True)),None)
    if not entry:raise ValueError('音色不在已同步的列表中，请先同步。')
    if model!='cosyvoice-v3.5-flash' or not voice.startswith(model+'-'):
        raise ValueError('Flash 音色配置不匹配，请检查本机云端配置。')
    if not 0<len(text)<=5000:raise ValueError('云端每段需为1–5000字符。')
    fingerprint=hashlib.sha256(json.dumps([model,voice,text,'pcm24000-rate1-v1'],ensure_ascii=False).encode()).hexdigest()
    cache=CACHE/(fingerprint+'.wav')
    if cache.exists():
        audio=cache.read_bytes()
        if audio.startswith(b'RIFF') and len(audio)>44:return audio
    keys=credentials();key=keys[entry.get('key_index',options.get('key_index',0))]
    task=uuid.uuid4().hex;connection=None;pcm=bytearray();started=False
    def event(action,payload):return json.dumps({'header':{'action':action,'task_id':task,'streaming':'duplex'},'payload':payload},ensure_ascii=False)
    try:
        connection=websocket.create_connection('wss://dashscope.aliyuncs.com/api-ws/v1/inference',header={'Authorization':'Bearer '+key},timeout=45)
        connection.send(event('run-task',{'task_group':'audio','task':'tts','function':'SpeechSynthesizer','model':model,
            'parameters':{'text_type':'PlainText','voice':voice,'format':'pcm','sample_rate':24000,'volume':50,'rate':1,'pitch':1},'input':{}}))
        deadline=time.monotonic()+90
        while time.monotonic()<deadline:
            message=connection.recv()
            if isinstance(message,bytes):
                pcm.extend(message)
                if len(pcm)>24_000*2*600:raise ValueError('云端音频超过长度上限。')
                continue
            if not message:raise ValueError('云端连接提前结束，请重试。')
            header=json.loads(message).get('header',{});status=header.get('event')
            if status=='task-started' and not started:
                started=True;connection.send(event('continue-task',{'input':{'text':text}}));connection.send(event('finish-task',{'input':{}}))
            elif status=='task-failed':
                code=re.sub(r'[^A-Za-z0-9_.-]','',str(header.get('error_code','Unknown')))[:100] or 'Unknown'
                if code.startswith('InvalidParameter'):
                    hint='输入文本或参数无效，请从当前句重试；若仍失败，请换一段文字测试。'
                elif 'Quota' in code or 'Balance' in code or 'Arrearage' in code:
                    hint='请检查该 API 对应的额度和计费状态。'
                elif 'Auth' in code or 'Access' in code:
                    hint='请检查 API 或音色权限。'
                else:hint='服务未能完成本段，请稍后从当前句重试。'
                raise ValueError('CosyVoice 合成失败：'+code+'。'+hint)
            elif status=='task-finished':
                if not started or not pcm:raise ValueError('云端没有返回音频。')
                result=io.BytesIO()
                with wave.open(result,'wb') as audio:
                    audio.setnchannels(1);audio.setsampwidth(2);audio.setframerate(24000);audio.writeframes(bytes(pcm))
                audio=result.getvalue()
                try:
                    CACHE.mkdir(parents=True,exist_ok=True);temporary=cache.with_suffix('.'+uuid.uuid4().hex+'.tmp');temporary.write_bytes(audio);temporary.replace(cache)
                    prune_cache()
                except OSError:pass  # A full cache disk must not discard paid audio.
                return audio
        raise ValueError('云端合成超时，请稍后重试。')
    except (websocket.WebSocketException,OSError) as exc:
        # Library errors can contain request headers; never propagate them.
        raise ValueError('无法连接 CosyVoice，请检查网络和 API 权限。') from None
    finally:
        if connection:connection.close()

def prune_cache():
    files=[(path.stat(),path) for path in CACHE.glob('*.wav')]
    total=sum(stat.st_size for stat,_ in files)
    for stat,path in sorted(files,key=lambda item:item[0].st_mtime):
        if total<=128*1024*1024:
            break
        path.unlink(missing_ok=True)
        total-=stat.st_size
