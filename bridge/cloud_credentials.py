"""Windows user-bound credential storage. Never expose credentials over HTTP."""
import ctypes,json,os
from ctypes import wintypes
from pathlib import Path

DATA_DIR=Path(os.environ.get('LOCALAPPDATA',Path.home()))/'VoiceDockReader'
FILE=DATA_DIR/'cloud-keys.dpapi'
class Blob(ctypes.Structure):
    _fields_=[('size',wintypes.DWORD),('data',ctypes.POINTER(ctypes.c_ubyte))]

def transform(data,protect):
    buffer=ctypes.create_string_buffer(data)
    incoming=Blob(len(data),ctypes.cast(buffer,ctypes.POINTER(ctypes.c_ubyte)));out=Blob()
    crypt=ctypes.windll.crypt32
    if protect:ok=crypt.CryptProtectData(ctypes.byref(incoming),None,None,None,None,1,ctypes.byref(out))
    else:ok=crypt.CryptUnprotectData(ctypes.byref(incoming),None,None,None,None,1,ctypes.byref(out))
    if not ok:raise OSError('无法读取当前 Windows 用户的云端凭据。')
    try:return ctypes.string_at(out.data,out.size)
    finally:ctypes.windll.kernel32.LocalFree(out.data)

def save(keys):
    FILE.parent.mkdir(parents=True,exist_ok=True)
    temporary=FILE.with_suffix('.tmp')
    temporary.write_bytes(transform(json.dumps(keys).encode(),True))
    temporary.replace(FILE)

def load():
    return json.loads(transform(FILE.read_bytes(),False))
