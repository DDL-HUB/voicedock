"""Trim only quiet edges of PCM16 WAV audio; keep breath/consonant margins."""
import io,wave,array,sys
def trim_edges(data,threshold=100,padding_ms=40):
    try:
        with wave.open(io.BytesIO(data),'rb') as wav:
            if wav.getsampwidth()!=2 or wav.getcomptype()!='NONE':return data
            channels=wav.getnchannels();rate=wav.getframerate();raw=wav.readframes(wav.getnframes())
        samples=array.array('h',raw)
        if sys.byteorder!='little':samples.byteswap()
        block=max(1,rate//100)*channels
        active=[i for i in range(0,len(samples),block) if max((abs(s)for s in samples[i:i+block]),default=0)>threshold]
        if not active:return data
        padding=rate*padding_ms//1000*channels
        start=max(0,active[0]-padding)//channels*channels;end=min(len(samples),active[-1]+block+padding)//channels*channels
        output=io.BytesIO()
        with wave.open(output,'wb') as wav:
            wav.setnchannels(channels);wav.setsampwidth(2);wav.setframerate(rate);wav.writeframes(raw[start*2:end*2])
        return output.getvalue()
    except (wave.Error,ValueError,EOFError):return data
