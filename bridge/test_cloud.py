import unittest,json,struct,io,wave,tempfile
from pathlib import Path
from unittest.mock import patch
import cloud_provider
class Socket:
    def __init__(self,fail=False):
        self.messages=[json.dumps({'header':{'event':'task-started'}}),struct.pack('<hhhh',0,500,-500,0),json.dumps({'header':{'event':'task-finished'}})]
        if fail:self.messages=[json.dumps({'header':{'event':'task-failed','error_code':'QuotaExceeded','error_message':'private detail'}})]
        self.sent=[];self.closed=False
    def send(self,value):self.sent.append(json.loads(value))
    def recv(self):return self.messages.pop(0)
    def close(self):self.closed=True
class Tests(unittest.TestCase):
    def test_punctuation_is_rejected_without_cloud_request(self):
        with patch.object(cloud_provider.websocket,'create_connection') as connect:
            for text in ['.', '. . .', '……', '— ！？？']:
                with self.assertRaisesRegex(ValueError,'标点'):cloud_provider.synthesize(text)
            connect.assert_not_called()
    def test_invalid_parameter_does_not_blame_balance_or_expose_provider_detail(self):
        socket=Socket(True)
        socket.messages=[json.dumps({'header':{'event':'task-failed','error_code':'InvalidParameter','error_message':'private detail'}})]
        with patch.object(cloud_provider,'credentials',return_value=['secret']),patch.object(cloud_provider,'config',return_value={'model':'cosyvoice-v3.5-flash','voice_id':'cosyvoice-v3.5-flash-test'}),patch.object(cloud_provider.websocket,'create_connection',return_value=socket):
            with self.assertRaises(ValueError) as caught:cloud_provider.synthesize('Hello.')
        message=str(caught.exception)
        self.assertIn('InvalidParameter',message);self.assertIn('文本或参数',message)
        self.assertNotIn('余额',message);self.assertNotIn('private detail',message)
    def test_hidden_presets_not_listed_or_synthesized(self):
        options={'model':'cosyvoice-v3.5-flash','voice_id':'cosyvoice-v3.5-flash-first','name':'Keep','voices':[{'voice_id':'cosyvoice-v3.5-flash-hidden','name':'Hidden','visible':False}]}
        with patch.object(cloud_provider,'config',return_value=options),patch.object(cloud_provider.websocket,'create_connection') as connect:
            self.assertEqual(len(cloud_provider.public_voices()),1)
            with self.assertRaises(ValueError):cloud_provider.synthesize('Hello.',voice_id='cosyvoice-v3.5-flash-hidden')
            connect.assert_not_called()
    def test_sync_only_flash_and_preserve_local_names(self):
        options={'model':'cosyvoice-v3.5-flash','voice_id':'cosyvoice-v3.5-flash-first','name':'Favorite'}
        response=type('Response',(),{'status_code':200,'json':lambda self:{'output':{'voice_list':[{'voice_id':'cosyvoice-v3.5-flash-first','target_model':'cosyvoice-v3.5-flash','status':'OK'},{'voice_id':'cosyvoice-v3.5-flash-second','target_model':'cosyvoice-v3.5-flash','status':'OK'},{'voice_id':'cosyvoice-v3.5-plus-other','target_model':'cosyvoice-v3.5-plus','status':'OK'}]}}})()
        with patch.object(cloud_provider,'config',return_value=options),patch.object(cloud_provider,'credentials',return_value=['secret']),patch.object(cloud_provider.requests,'post',return_value=response),patch.object(cloud_provider,'save_config'):
            public=cloud_provider.sync_voices()
        self.assertEqual(len(public),2);self.assertEqual(public[0]['name'],'Favorite');self.assertNotIn('plus',str(public))
    def test_selected_voice_is_used_and_has_separate_cache(self):
        options={'model':'cosyvoice-v3.5-flash','voice_id':'cosyvoice-v3.5-flash-first','voices':[{'voice_id':'cosyvoice-v3.5-flash-second','name':'Second'}]}
        one,two=Socket(),Socket()
        with patch.object(cloud_provider,'credentials',return_value=['secret']),patch.object(cloud_provider,'config',return_value=options),patch.object(cloud_provider.websocket,'create_connection',side_effect=[one,two]) as connect:
            cloud_provider.synthesize('Same text.')
            cloud_provider.synthesize('Same text.',voice_id='cosyvoice-v3.5-flash-second')
            cloud_provider.synthesize('Same text.',voice_id='cosyvoice-v3.5-flash-second')
            self.assertEqual(connect.call_count,2)
            self.assertEqual(two.sent[0]['payload']['parameters']['voice'],'cosyvoice-v3.5-flash-second')
    def test_unknown_voice_never_reaches_cloud(self):
        with patch.object(cloud_provider,'config',return_value={'model':'cosyvoice-v3.5-flash','voice_id':'cosyvoice-v3.5-flash-first'}),patch.object(cloud_provider.websocket,'create_connection') as connect:
            with self.assertRaises(ValueError):cloud_provider.synthesize('Hello.',voice_id='cosyvoice-v3.5-flash-unlisted')
            connect.assert_not_called()
    def setUp(self):
        self.folder=tempfile.TemporaryDirectory();self.addCleanup(self.folder.cleanup)
        patcher=patch.object(cloud_provider,'CACHE',Path(self.folder.name),create=True);patcher.start();self.addCleanup(patcher.stop)
    def test_replaying_same_text_uses_cached_audio_without_api_charge(self):
        socket=Socket()
        with patch.object(cloud_provider,'credentials',return_value=['secret']),patch.object(cloud_provider,'config',return_value={'model':'cosyvoice-v3.5-flash','voice_id':'cosyvoice-v3.5-flash-test'}),patch.object(cloud_provider.websocket,'create_connection',return_value=socket) as connect:
            first=cloud_provider.synthesize('Repeat this sentence.')
            second=cloud_provider.synthesize('Repeat this sentence.')
            self.assertEqual(first,second);self.assertEqual(connect.call_count,1)
    def test_flash_voice_and_complete_sentence(self):
        socket=Socket()
        with patch.object(cloud_provider,'credentials',return_value=['secret']),patch.object(cloud_provider,'config',return_value={'model':'cosyvoice-v3.5-flash','voice_id':'cosyvoice-v3.5-flash-test','key_index':0}),patch.object(cloud_provider.websocket,'create_connection',return_value=socket):
            audio=cloud_provider.synthesize('Dr Packard spoke, and then opened the door.')
        self.assertTrue(audio.startswith(b'RIFF'));self.assertTrue(socket.closed)
        self.assertEqual(socket.sent[0]['payload']['model'],'cosyvoice-v3.5-flash')
        self.assertEqual(socket.sent[1]['payload']['input']['text'],'Dr Packard spoke, and then opened the door.')
        self.assertEqual(len({m['header']['task_id']for m in socket.sent}),1)
    def test_failure_does_not_use_another_voice_or_key(self):
        socket=Socket(True)
        with patch.object(cloud_provider,'credentials',return_value=['first','second']),patch.object(cloud_provider,'config',return_value={'model':'cosyvoice-v3.5-flash','voice_id':'cosyvoice-v3.5-flash-test'}),patch.object(cloud_provider.websocket,'create_connection',return_value=socket) as connect:
            with self.assertRaisesRegex(ValueError,'QuotaExceeded'):cloud_provider.synthesize('Hello.')
            self.assertEqual(connect.call_count,1)
        self.assertTrue(socket.closed)
