import unittest,io,wave,struct
from audio_edges import trim_edges
class Tests(unittest.TestCase):
    def test_remove_only_edge_silence_not_mid_sentence_pause(self):
        source=io.BytesIO()
        frames=[0]*24000+[1500]*2400+[0]*4800+[1500]*2400+[0]*24000
        with wave.open(source,'wb') as w:w.setnchannels(1);w.setsampwidth(2);w.setframerate(24000);w.writeframes(struct.pack('<'+'h'*len(frames),*frames))
        with wave.open(io.BytesIO(trim_edges(source.getvalue()))) as w:
            self.assertAlmostEqual(w.getnframes()/24000,.48,places=2)
            self.assertIn(b'\0'*4000,w.readframes(w.getnframes()))
